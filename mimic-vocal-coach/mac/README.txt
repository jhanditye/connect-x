MIMIC VOCAL COACH FOR MAC
=========================

Mimic listens to you sing and coaches you phrase by phrase. This folder runs
on your own Mac. Nothing is installed, there is no account, and your
recordings never leave the computer.


START IT (3 steps)
------------------

 1. Unzip Mimic-for-Mac.zip (double-click it) and move the Mimic-for-Mac
    folder somewhere you will keep it. Your home folder is best (in Finder,
    choose Go > Home, then drag the folder there); Applications also works.
    Avoid Documents, Desktop and Downloads: macOS may ask permission there,
    and may keep the files in iCloud instead of on this Mac. Keep everything
    in the folder together.

 2. Double-click "Start Mimic.command". A Terminal window opens and, a
    moment later, Mimic opens in your web browser.

 3. When the browser asks to use your microphone, click Allow, then sing.
    Keep the Terminal window open while you use Mimic. To stop Mimic, press
    Control-C in that window, or close it (if Terminal asks whether to
    terminate the running process, click Terminate).

You need Safari 16.4 or newer (Software Update brings Safari up to date), or
a current Chrome.

Next time, do step 2 again. Always start Mimic this way (see "Where your
recordings are kept" below).


IF macOS WILL NOT OPEN "Start Mimic.command"
--------------------------------------------

Because the file came from a download, macOS may refuse to open it or say it
cannot check it for malicious software. Two ways round that:

 A. This always works. Open Terminal (Applications > Utilities > Terminal).
    Type the word  bash  followed by a space. Then drag the file
    "Start Mimic.command" from its folder into the Terminal window, and
    press Return.

 B. Double-click the file once so that macOS blocks it. Then open
    System Settings > Privacy & Security, scroll down to the Security
    section, and click "Open Anyway" next to "Start Mimic.command". Confirm
    with your password if asked, and click Open if macOS asks once more.
    After that, double-clicking works. (Not every macOS version words this
    the same way; if you do not see it, use A.)

(If double-clicking does nothing at all, use A.)


WHICH BROWSER
-------------

Safari and Chrome both work. Mimic opens in your usual (default) browser.
To use the other one, start Mimic as above and then copy the address shown
in the Terminal window, http://localhost:47321/, into that browser.

Pick one browser and keep using it: each browser keeps its own recordings.
Headphones are best when you sing along with a clip.


THE MICROPHONE
--------------

The first time, the browser asks whether "localhost" may use your
microphone. Click Allow. If you clicked Don't Allow by mistake, or Safari
keeps asking every time:
  Safari:  Safari > Settings > Websites > Microphone, set localhost to Allow.
  Chrome:  click the icon at the left of the address bar, then allow the
           Microphone.
macOS also keeps its own switch for apps: System Settings > Privacy &
Security > Microphone. If your browser is listed there, make sure it is
switched on.


WHERE YOUR RECORDINGS ARE KEPT
------------------------------

Your clips, phrases, takes and scores are stored by your browser, for the
address localhost:47321. They are not stored in this folder. So:

 - Always start Mimic with "Start Mimic.command" (same address every time).
 - Use the same browser every time.
 - Deleting this folder does not delete your recordings, and clearing the
   browser's website data for localhost does.
 - Safari may erase a website's saved data if you do not visit that site
   for about a week of using Safari. Chrome keeps it unless the disk is
   nearly full. If you use Safari, or before you clear browser data or
   change browser, open Mimic > Settings and use "Export my library". A
   backup holds phrases and scores, not audio, so keep your original audio
   files.


UPDATING
--------

Quit Mimic (Control-C in the Terminal window). Then either replace the "app"
folder, "server.pl" and "Start Mimic.command" with the new ones, or simply
unzip the new Mimic-for-Mac.zip and start Mimic from the new folder. Your
recordings stay: they live in the browser, not in the folder. Open Mimic in
the same browser; the first visit after an update may need one reload.

If the old Mimic is still running when you start the new one, the launcher
says so and opens the old one. Close the old Terminal window (Control-C) and
start again. If you cannot find that window, restart your Mac.


UNINSTALLING
------------

Quit Mimic and drag the Mimic-for-Mac folder to the Trash. That removes the
program. Your recordings are still in the browser. To remove them too, clear
the website data for "localhost" there:
  Safari:  Safari > Settings > Privacy > Manage Website Data, search for
           localhost, Remove.
  Chrome:  Settings > Privacy and security > Third-party cookies > See all
           site data and permissions, search for localhost, delete.
(The wording of these menus changes a little between versions.)


IMPORTING SONGS AND VOCAL ISOLATION
-----------------------------------

Use "Add clips" in Mimic to import songs you own. The optional "Isolate the
vocal first (AI)" step runs on your Mac, with no internet, using the model
file that is inside this folder (app/models). The first time, Mimic copies
that file into the browser (about 20 MB); Mimic must be running for that.
By default it works on the first minute of a song; a whole song takes
longer. The result is approximate.


IF SOMETHING GOES WRONG
-----------------------

 - "port 47321 is already in use": Mimic is probably already open in another
   Terminal window. Use that one, or close it and start again. To stop a
   Mimic you cannot find, restart your Mac.
 - The page does not load: check the Terminal window is still open.
 - After you stop Mimic, a browser tab that is already open may keep
   working for a while from its saved copy. That does not mean Mimic is
   still running: new things, such as setting up vocal isolation, will not
   work until you start it again.
 - The window says "Operation not permitted", or cannot find its files
   although they are there: macOS has stopped Terminal from opening that
   folder. Click OK if macOS asks whether Terminal may access files in a
   folder. Or open System Settings > Privacy & Security > Files and Folders
   (or Full Disk Access) and switch Terminal on. Or move the Mimic-for-Mac
   folder to your home folder.
 - The window says there is no "perl": Mimic's small server is written in
   it, and every Mac normally has it. If macOS offers to install "command
   line developer tools", click Install, wait until it finishes, and
   double-click "Start Mimic.command" again. If there is no such offer,
   Mimic cannot run on this Mac.
 - Mimic needs nothing from the internet, except the optional AI coach in
   its Settings, if you choose to use it.


LICENCE NOTE
------------

The vocal-isolation feature uses the Spleeter model from Deezer. Spleeter's
code is MIT-licensed, but Deezer states no separate licence for the trained
model file. So this folder is for your personal use: please do not post it
or share it publicly.
