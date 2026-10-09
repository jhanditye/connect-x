#!/usr/bin/perl
# Mimic for Mac: a tiny static web server. Core Perl only (5.18 or newer), no CPAN, nothing to install.
#
#   perl server.pl [folder]      folder defaults to "app" next to this file (or $MIMIC_ROOT)
#
# Why it exists: the microphone only works on a "secure" page, and http://localhost counts as one in Safari and Chrome. So the app
# is served from this machine, to this machine, on a FIXED port (browser storage belongs to the address, so a port that changed
# would make saved clips seem to vanish). It listens on 127.0.0.1 only and never on the network.
#
# Environment: MIMIC_PORT or PORT (default 47321; MIMIC_PORT wins, so a PORT left over from another project cannot move the app),
# MIMIC_ROOT (folder to serve), MIMIC_VERBOSE (one log line per request on stderr).
# Prints nothing unless it cannot start (one line on stderr, exit status 1) or MIMIC_VERBOSE is set.
use strict;
use warnings;
use FindBin ();
use Cwd ();
use POSIX ();
use Socket ();
use IO::Socket::INET ();

use constant DEFAULT_PORT   => 47321;
use constant HEADER_LIMIT   => 32768;    # bytes of request line + headers we are willing to read
use constant CHUNK          => 262144;   # file bytes per read/write
use constant ONE_YEAR       => 31536000;

# Limits. The two MIMIC_* overrides exist so the tests can reach the limits quickly; nobody needs them.
my $MAX_CHILDREN = 200;    # connections served at once (each child is a copy-on-write perl); more wait in the kernel's queue
my $HEAD_TIMEOUT = 10;     # seconds a client may take to send its request (browsers close their spare connections sooner)
my $IO_TIMEOUT   = 30;     # seconds a client may stop reading while we write
if (defined $ENV{MIMIC_MAX_CHILDREN} && $ENV{MIMIC_MAX_CHILDREN} =~ /\A[0-9]{1,4}\z/ && $ENV{MIMIC_MAX_CHILDREN} >= 1) { $MAX_CHILDREN = $ENV{MIMIC_MAX_CHILDREN} + 0; }
if (defined $ENV{MIMIC_IO_TIMEOUT} && $ENV{MIMIC_IO_TIMEOUT} =~ /\A[0-9]{1,3}\z/ && $ENV{MIMIC_IO_TIMEOUT} >= 1) { $IO_TIMEOUT = $HEAD_TIMEOUT = $ENV{MIMIC_IO_TIMEOUT} + 0; }

my $VERBOSE = (defined $ENV{MIMIC_VERBOSE} && length $ENV{MIMIC_VERBOSE}) ? 1 : 0;

my $port = DEFAULT_PORT;
foreach my $name ('MIMIC_PORT', 'PORT') {
    if (defined $ENV{$name} && length $ENV{$name}) { $port = $ENV{$name}; last; }
}
if ($port !~ /\A[0-9]{1,5}\z/ || $port < 1 || $port > 65535) { die_line("PORT must be a number from 1 to 65535 (got '$port')."); }
$port += 0;

my $root_arg = @ARGV ? $ARGV[0] : (defined $ENV{MIMIC_ROOT} && length $ENV{MIMIC_ROOT} ? $ENV{MIMIC_ROOT} : "$FindBin::Bin/app");
my $root = Cwd::abs_path($root_arg);
if (!defined $root || !-d $root) { die_line("the app folder '$root_arg' was not found. Keep \"app\" next to server.pl."); }
if (!-f "$root/index.html") { die_line("'$root_arg' has no index.html, so it is not the Mimic app folder."); }

# Which folder this server serves. The launcher compares it with its own, to tell a Mimic started from an older copy from this one.
(my $FOLDER_HEADER = $root) =~ s/[\x00-\x1f\x7f]/?/g;

my @DAY = qw(Sun Mon Tue Wed Thu Fri Sat);
my @MON = qw(Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec);
my %REASON = (
    200 => 'OK', 206 => 'Partial Content', 304 => 'Not Modified',
    400 => 'Bad Request', 403 => 'Forbidden', 404 => 'Not Found', 405 => 'Method Not Allowed',
    408 => 'Request Timeout', 416 => 'Range Not Satisfiable', 431 => 'Request Header Fields Too Large',
    500 => 'Internal Server Error',
);

my %TYPE = (
    html        => 'text/html; charset=utf-8',
    htm         => 'text/html; charset=utf-8',
    js          => 'text/javascript; charset=utf-8',
    mjs         => 'text/javascript; charset=utf-8',
    css         => 'text/css; charset=utf-8',
    json        => 'application/json; charset=utf-8',
    webmanifest => 'application/manifest+json; charset=utf-8',
    wasm        => 'application/wasm',
    onnx        => 'application/octet-stream',
    png         => 'image/png',
    svg         => 'image/svg+xml',
    ico         => 'image/x-icon',
    woff        => 'font/woff',
    woff2       => 'font/woff2',
    txt         => 'text/plain; charset=utf-8',
    map         => 'application/json; charset=utf-8',
);

# ---- listen (127.0.0.1 only)
my $listener = IO::Socket::INET->new(
    LocalAddr => '127.0.0.1',
    LocalPort => $port,
    Proto     => 'tcp',
    Listen    => 128,
    ReuseAddr => 1,
);
if (!$listener) {
    my $err = $!;
    if ($!{EADDRINUSE}) {
        die_line("port $port is already in use, so Mimic cannot start. Is Mimic already open in another window? Close that one first.");
    }
    die_line("cannot listen on 127.0.0.1:$port ($err).");
}

# A client that goes away must not kill us (SIGPIPE) or leave zombies behind.
$SIG{PIPE} = 'IGNORE';
my %kids;
$SIG{CHLD} = sub {
    local ($!, $?);
    my $pid;
    while (($pid = waitpid(-1, POSIX::WNOHANG())) > 0) { delete $kids{$pid}; }
};
my $stop = sub { local $SIG{TERM} = 'IGNORE'; kill 'TERM', keys %kids; exit 0; };
$SIG{INT} = $SIG{TERM} = $SIG{HUP} = $stop;

# SIGCHLD is blocked from just before fork() until the parent has written down the child's pid. Without that, a child that
# finishes in between is reaped by the handler first and its pid is then recorded for ever, until the table looks full.
my $chld_set = POSIX::SigSet->new(POSIX::SIGCHLD());
my $old_set  = POSIX::SigSet->new();

# Forget children that are already gone, whatever the handler saw (waitpid says -1 for a pid that is not ours any more).
sub prune_kids {
    foreach my $pid (keys %kids) {
        my $r = waitpid($pid, POSIX::WNOHANG());
        delete $kids{$pid} if $r != 0;
    }
}

while (1) {
    # Cap the number of concurrent children: wait for one to finish (SIGCHLD interrupts the sleep).
    if (scalar(keys %kids) >= $MAX_CHILDREN) {
        prune_kids();
        while (scalar(keys %kids) >= $MAX_CHILDREN) {
            select(undef, undef, undef, 0.05);
            prune_kids();
        }
    }
    my $client = $listener->accept();
    if (!$client) {            # interrupted by a signal, or the client vanished before we accepted
        select(undef, undef, undef, 0.05) unless $!{EINTR};
        next;
    }
    POSIX::sigprocmask(POSIX::SIG_BLOCK(), $chld_set, $old_set);
    my $pid = fork();
    if (!defined $pid) {       # out of processes: drop this one connection, keep serving
        POSIX::sigprocmask(POSIX::SIG_SETMASK(), $old_set);
        close $client;
        select(undef, undef, undef, 0.1);
        next;
    }
    if ($pid) {
        $kids{$pid} = 1;
        POSIX::sigprocmask(POSIX::SIG_SETMASK(), $old_set);    # a SIGCHLD that arrived meanwhile is handled now
        close $client;
        next;
    }
    # ---- child: one request, then gone
    $SIG{CHLD} = 'DEFAULT';
    $SIG{INT} = $SIG{TERM} = $SIG{HUP} = 'DEFAULT';
    POSIX::sigprocmask(POSIX::SIG_SETMASK(), $old_set);
    close $listener;
    # Non-blocking, so the 30 s stall limit in write_all really applies: a blocking send of 256 KB to a client that has stopped
    # reading would wait for ever.
    eval { $client->blocking(0); 1 };
    eval { setsockopt($client, Socket::IPPROTO_TCP(), Socket::TCP_NODELAY(), 1); 1 };
    eval { serve($client); 1 } or log_line("error: $@");
    close $client;
    POSIX::_exit(0);
}

# ------------------------------------------------------------------------------------------------------------------------------

sub die_line {
    my ($msg) = @_;
    print STDERR "Mimic server: $msg\n";
    exit 1;
}

sub log_line {
    return unless $VERBOSE;
    my ($line) = @_;
    $line =~ s/[^\x20-\x7e]/?/g;
    print STDERR "$line\n";
}

sub http_date {    # by hand: strftime would follow the Mac's language settings
    my @t = gmtime(shift);
    return sprintf('%s, %02d %s %04d %02d:%02d:%02d GMT', $DAY[$t[6]], $t[3], $MON[$t[4]], $t[5] + 1900, $t[2], $t[1], $t[0]);
}

# Write all of $data, giving up when the client stops reading or disconnects. Returns true when everything went out.
sub write_all {
    my ($sock, $data) = @_;
    my $off = 0;
    my $len = length $data;
    my $fn = fileno($sock);
    while ($off < $len) {
        my $w = '';
        vec($w, $fn, 1) = 1;
        my $n = select(undef, $w, undef, $IO_TIMEOUT);
        if ($n < 0) { next if $!{EINTR}; return 0; }
        return 0 if $n == 0;    # the client has stalled
        my $put = syswrite($sock, $data, $len - $off, $off);
        if (!defined $put) {
            next if $!{EINTR} || $!{EAGAIN} || $!{EWOULDBLOCK};
            return 0;           # EPIPE, ECONNRESET: the client went away
        }
        $off += $put;
    }
    return 1;
}

# Read the request line and headers. Returns the raw header block (without the blank line) or undef plus a status code.
sub read_head {
    my ($sock) = @_;
    my $buf = '';
    my $fn = fileno($sock);
    my $deadline = time + $HEAD_TIMEOUT;
    while (1) {
        if ($buf =~ /\r?\n\r?\n/) { last; }
        return (undef, 431) if length($buf) > HEADER_LIMIT;
        my $left = $deadline - time;
        return (undef, ($buf eq '' ? 0 : 408)) if $left <= 0;    # a connection that never said anything is just closed
        my $r = '';
        vec($r, $fn, 1) = 1;
        my $n = select($r, undef, undef, $left);
        if ($n < 0) { next if $!{EINTR}; return (undef, 0); }
        return (undef, ($buf eq '' ? 0 : 408)) if $n == 0;
        my $got = sysread($sock, $buf, 8192, length $buf);
        if (!defined $got) { next if $!{EINTR} || $!{EAGAIN}; return (undef, 0); }
        return (undef, 0) if $got == 0;    # closed without sending a request (browsers open spare connections)
    }
    $buf =~ s/\r?\n\r?\n.*\z//s;
    return ($buf, 0);
}

sub send_simple {
    my ($sock, $code, $extra, $head_only) = @_;
    my $body = "$code $REASON{$code}\n";
    my $out = "HTTP/1.1 $code $REASON{$code}\r\n"
        . 'Date: ' . http_date(time) . "\r\n"
        . "Content-Type: text/plain; charset=utf-8\r\n"
        . 'Content-Length: ' . length($body) . "\r\n"
        . "Cache-Control: no-store\r\n"
        . "X-Content-Type-Options: nosniff\r\n"
        . "Connection: close\r\n"
        . ($extra // '')
        . "\r\n";
    $out .= $body unless $head_only;
    write_all($sock, $out);
    return $code;
}

# Percent-decode once. Returns undef for a malformed escape.
sub pct_decode {
    my ($s) = @_;
    return undef if $s =~ /%(?![0-9A-Fa-f]{2})/;
    $s =~ s/%([0-9A-Fa-f]{2})/chr(hex($1))/ge;
    return $s;
}

# URL path -> absolute file path inside $root, or (undef, status).
sub resolve_path {
    my ($raw) = @_;
    my $decoded = pct_decode($raw);
    return (undef, 400) unless defined $decoded;
    return (undef, 400) if $decoded =~ /[\x00-\x1f\x7f]/;    # NUL, control characters
    return (undef, 403) if index($decoded, '\\') >= 0;       # backslash: never a path separator here
    return (undef, 400) unless substr($decoded, 0, 1) eq '/';
    my @seg = grep { length $_ && $_ ne '.' } split m{/}, $decoded;
    foreach my $s (@seg) {
        return (undef, 403) if $s eq '..';
        return (undef, 404) if substr($s, 0, 1) eq '.';      # dot files are never served
    }
    my $wants_dir = ($decoded =~ m{/\z}) ? 1 : 0;
    my $candidate = join('/', $root, @seg);
    my $real = Cwd::abs_path($candidate);
    return (undef, 404) unless defined $real;
    # the real path (symlinks resolved) must still be inside the root
    return (undef, 403) unless $real eq $root || index($real, "$root/") == 0;
    if (-d $real) {
        return (undef, 404) unless $wants_dir || !@seg;      # no redirects, no listings: only "/" and "dir/" can map to an index
        $real = "$real/index.html";
        $real = Cwd::abs_path($real);
        return (undef, 404) unless defined $real && index($real, "$root/") == 0;
    }
    return (undef, 404) unless -f $real;
    return ($real, 0);
}

sub cache_control {
    my ($url_path) = @_;
    # Vite's hashed files (assets/name-AbCd1234.ext) never change under that name.
    return 'public, max-age=' . ONE_YEAR . ', immutable' if $url_path =~ m{\A/assets/[^/]+-[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+\z};
    # Everything else is revalidated each time (cheap: ETag, 304). The service worker file and the page must always be fresh.
    return 'no-cache';
}

sub serve {
    my ($sock) = @_;
    my ($head, $err) = read_head($sock);
    if (!defined $head) {
        send_simple($sock, $err) if $err;
        return;
    }
    my @lines = split /\r?\n/, $head;
    my $request_line = shift @lines;
    return send_simple($sock, 400) unless defined $request_line && $request_line =~ m{\A([A-Za-z]+) (\S+) HTTP/1\.[01]\z};
    my ($method, $target) = ($1, $2);
    my %h;
    foreach my $l (@lines) {
        next unless $l =~ /\A([A-Za-z0-9!#\$%&'*+.^_`|~-]+):[ \t]*(.*?)[ \t]*\z/;
        $h{lc $1} = $2;
    }
    my $status = handle($sock, $method, $target, \%h);
    log_line("$method $target $status");
}

sub handle {
    my ($sock, $method, $target, $h) = @_;
    if ($method ne 'GET' && $method ne 'HEAD') {
        return send_simple($sock, 405, "Allow: GET, HEAD\r\n");
    }
    my $head_only = $method eq 'HEAD';

    # absolute-form targets ("GET http://host/path") are allowed; the query and fragment never matter to a static file
    (my $path = $target) =~ s{\Ahttps?://[^/?#]*}{}i;
    $path =~ s/[?#].*\z//s;
    $path = '/' if $path eq '';

    my ($file, $bad) = resolve_path($path);
    return send_simple($sock, $bad, '', $head_only) unless defined $file;

    my @st = stat($file);
    return send_simple($sock, 404, '', $head_only) unless @st;
    my ($size, $mtime) = ($st[7], $st[9]);

    my ($ext) = $file =~ /\.([^.\/]+)\z/;
    my $type = ($ext && $TYPE{lc $ext}) || 'application/octet-stream';
    my $etag = sprintf('"%x-%x"', $size, $mtime);
    my $common = "Content-Type: $type\r\n"
        . 'Cache-Control: ' . cache_control($path) . "\r\n"
        . "ETag: $etag\r\n"
        . 'Last-Modified: ' . http_date($mtime) . "\r\n"
        . "Accept-Ranges: bytes\r\n"
        . "X-Content-Type-Options: nosniff\r\n"
        . "X-Mimic-Folder: $FOLDER_HEADER\r\n"
        . "Connection: close\r\n";

    # conditional request: the browser already has this exact file
    if (defined $h->{'if-none-match'}) {
        my $inm = $h->{'if-none-match'};
        my $hit = ($inm eq '*') ? 1 : 0;
        foreach my $tag (split /\s*,\s*/, $inm) {
            (my $t = $tag) =~ s{\AW/}{};
            $hit = 1 if $t eq $etag;
        }
        if ($hit) {
            write_all($sock, "HTTP/1.1 304 Not Modified\r\nDate: " . http_date(time) . "\r\n$common\r\n");
            return 304;
        }
    }

    # a single byte range (audio seeking, resumed downloads); several ranges or odd syntax are answered with the whole file
    my ($from, $to, $code) = (0, $size - 1, 200);
    my $range = $h->{'range'};
    if (defined $range && defined $h->{'if-range'} && $h->{'if-range'} ne $etag) { $range = undef; }
    if (defined $range && $range =~ /\Abytes=\s*(\d*)\s*-\s*(\d*)\s*\z/i) {
        my ($a, $b) = ($1, $2);
        if ($a eq '' && $b eq '') {
            # "bytes=-" is not a valid range: ignore it
        } elsif ($a eq '') {                      # suffix: the last N bytes
            if ($b eq '' || $b == 0 || $size == 0) {
                return send_simple($sock, 416, "Content-Range: bytes */$size\r\n", $head_only);
            }
            $from = $size - $b; $from = 0 if $from < 0;
            $code = 206;
        } else {
            my $end = ($b eq '') ? $size - 1 : $b;
            if ($b ne '' && $end < $a) {
                # last < first: invalid, ignore the header
            } elsif ($a >= $size) {
                return send_simple($sock, 416, "Content-Range: bytes */$size\r\n", $head_only);
            } else {
                $from = $a + 0;
                $to = $end >= $size ? $size - 1 : $end + 0;
                $code = 206;
            }
        }
    }
    my $len = $size == 0 ? 0 : $to - $from + 1;

    my $out = "HTTP/1.1 $code $REASON{$code}\r\nDate: " . http_date(time) . "\r\n$common"
        . ($code == 206 ? "Content-Range: bytes $from-$to/$size\r\n" : '')
        . "Content-Length: $len\r\n\r\n";
    if ($head_only) { write_all($sock, $out); return $code; }

    open(my $fh, '<', $file) or return send_simple($sock, 404);
    binmode $fh;
    if ($from > 0) { sysseek($fh, $from, 0) or return 500; }
    # The file goes out in chunks (a 20 MB model never sits in memory); the headers ride along with the first chunk.
    my $pending = $out;
    my $left = $len;
    while ($left > 0) {
        my $want = $left < CHUNK ? $left : CHUNK;
        my $buf;
        my $n = sysread($fh, $buf, $want);
        if (!defined $n) { next if $!{EINTR}; last; }
        last if $n == 0;    # the file shrank while we were sending it
        $buf = $pending . $buf;
        $pending = '';
        last unless write_all($sock, $buf);
        $left -= $n;
    }
    write_all($sock, $pending) if length $pending;
    close $fh;
    return $code;
}
