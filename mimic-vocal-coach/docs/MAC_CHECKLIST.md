# Mimic on your Mac: the checklist

Mimic for Mac was built and tested on a Linux computer. A desktop Chromium pretending to be Safari or Chrome on a Mac
checked the screens, and the text was read against what Safari and Chrome are known to do on macOS.
**It has never run on a real Mac.** Microphone prompts, Bluetooth headphones, file pickers and how long a browser keeps
your data all behave a little differently on the real thing. This list is how you find out, in about an hour, plus two
checks that need a few days.

Each check says what to do, what you should see, and what it protects against, so you know why it matters. If a check
fails, do not guess: write down what you saw (the exact words on screen help most) and put it in the report at the end.
Anything marked "should" in the app is something nobody could check from here.

## Before you start

- A Mac with **macOS 13 (Ventura) or newer**, Apple Silicon or Intel. **Safari 16.4 or newer**, or a current **Chrome**.
- The **Mimic-for-Mac** folder, unzipped, kept in a place you will leave it. Your **home folder** is best: Documents, Desktop and Downloads may ask
  "Terminal would like to access files in…" (click OK) and may be kept in iCloud. Note which place you used and whether macOS asked.
- Headphones with a microphone (wired, USB, or AirPods) and, if you have them, a pair **without** a microphone.
- A few files on the Mac: one **MP3 or M4A** you own, one **Voice Memo** (drag it out of the Voice Memos app onto the
  desktop), one short **video** (a .mov or .mp4 of a song you own), a longer song (4 to 5 minutes), and, if you have
  one, an **Apple Music download** and a song you **bought** from the iTunes Store.
- Do not use music you do not own. Mimic keeps clips only in your browser, but the rule is yours to follow.

## 1. Starting it and keeping your data

**1. Start it by double-clicking.** Double-click **Start Mimic.command**. If macOS refuses, follow the two ways round it in
`README.txt` (the one with Terminal always works).
*You should see:* a Terminal window that says "Starting Mimic...", and a moment later a banner and Mimic open in your usual browser at
`http://localhost:47321/`. Keep the Terminal window open while you use Mimic. Then double-click it a second time while the first is
running: it should say Mimic is already running, open the browser and show no error. Finally, close the Terminal window with the red
button: Terminal may ask whether to terminate the running process; click Terminate, and Mimic stops.
*Protects against:* a launcher macOS blocks without saying why, a page that opens blank, and a second double-click that looks like a failure.
Write down how long the first start took; if the window stays empty for more than a few seconds, say so.

**2. The same address every time.** Quit Mimic (Control-C in the Terminal window, or close it), start it again, and open
Settings, then scroll to "Offline and storage".
*You should see:* the same address, `localhost:47321`, in the browser bar and in the sentence under "Offline and storage"
("Your clips and scores are kept in this browser, for this address"), and **Works offline: Ready**.
*Protects against:* clips that seem to vanish because they were saved at another address or in another browser. Each
browser, and each address, has its own library. If you start Mimic on a different port on purpose, you should see an empty library there; that is expected.

**3. Your clips survive closing everything.** Add one clip (check 9). Quit the launcher, quit the browser, start the
launcher again, open Mimic in the **same browser**.
*You should see:* the clip and its scores. Also read what Settings says under "Data kept safe".
*Protects against:* the library not being saved, or the browser starting fresh.

**4. Your clips survive days (needs time).** Leave the clips for **a week** without opening Mimic in Safari, then open it
again. Do the same in Chrome if you use it.
*You should see:* the same clips. In **Safari** this is the one that may fail: Safari can erase a website's saved data after
about a week of not visiting it. Mimic says this in Settings and suggests **Export my library** (check 18) and, in Safari,
**File, Add to Dock** (check 19), which should protect the data better. Whether it does is exactly what this check shows.
*Protects against:* losing practice history without warning. Chrome should not do this.

## 2. Microphone

**5. The permission prompt, in Safari.** Open a phrase and click **Sing** for the first time.
*You should see:* Safari asking whether `localhost` (it may leave out the port) may use the microphone. Click **Allow**; the count-in starts.
Whether Safari asks again on a later visit is not known: if it does, set Microphone to Allow for localhost in Safari, Settings, Websites.
*Protects against:* a prompt that never appears (a page that is not on `localhost` cannot use the microphone at all).

**6. If you said No, in Safari.** In Safari choose **Safari, Settings for This Website** (or Safari, Settings, Websites,
Microphone) and set Microphone to **Deny**. Click Sing.
*You should see:* a message saying the microphone was blocked and naming those same menus ("Settings for This Website", or
"Settings, Websites, Microphone"). It also points at **System Settings, Privacy & Security, Microphone**, but only "if Safari is listed there":
**write down whether Safari is in that list at all**, because nobody could check. Follow the words, reload, and Sing works.
*Protects against:* a dead end where the person does not know how to turn the microphone back on.

**7. The same, in Chrome, and the macOS switch.** In Chrome click the icon at the left of the address bar, set Microphone to
**Block**, reload, click Sing.
*You should see:* a message about Chrome's "Site settings" and the icon at the left of the address bar. Fix it by those words.
Then, in System Settings, Privacy & Security, Microphone, switch **Chrome** **off** (Safari is probably not in that list; if it is, try it too and say so), and click Sing again.
*You should see:* the same message, which also names the System Settings switch. Switch it back on and quit and reopen the browser if macOS asks.
*Protects against:* a browser that is allowed but blocked by macOS itself, which looks identical to the person.

**8. Which microphone.** Settings, "Your voice", **Microphone**. Open the list.
*You should see:* your Mac's own microphone by name (for example "MacBook Pro Microphone"), and headphone or USB
microphones when they are plugged in, listed by name once you have allowed the microphone once.
*Protects against:* Mimic recording through the wrong microphone with no way to change it.

## 3. Getting clips in

**9. From Finder.** Trainer, **Add clips**, choose the MP3 or M4A. Then try again by **dragging** a file from Finder onto the sheet.
*You should see:* the sheet says the steps in Mac words (Finder, Music or Downloads folder, "drag them onto this window"),
no mention of the Files app or AirDrop, then a review with the phrases found in a few seconds. WAV, MP3, M4A, AAC, FLAC and AIFF should all be offered by the file picker.
*Protects against:* a file picker that greys out files, and words written for a phone.

**10. A Voice Memo, a video, and what Apple Music allows.** Add the Voice Memo you dragged to the desktop. Add the video.
Add a song you **bought** from the iTunes Store, then an **Apple Music download** if you have one.
*You should see:* the Voice Memo and the video import (the video uses only its sound, and says so). The purchased song should
import. The Apple Music download (a .m4p file, or an item that only exists in the Music app) is **offered in the file picker** and then refused
with a plain message that says it is copy-protected and how to get a file you own, not a message that it "does not look like audio".
For a very big video the message points to **QuickTime Player, File, Export As, Audio Only** (not the Shortcuts app).
*Protects against:* a blank screen on a protected file, and advice that only works on an iPhone. In the Music app, right-click a
song you bought and choose **Show in Finder** to find the file.

**11. A full song, then leaving mid-analysis.** Add the 4 to 5 minute song. While it is being read, switch to another app for
30 seconds and come back.
*You should see:* "This is a full song" switched on by itself, a Lead vocal rating in words, and a melody that follows
the singing; the analysis finishes or restarts cleanly, and the Mac does not stay busy afterwards.
*Protects against:* an analysis that never finishes, and a melody that follows the guitar instead of the voice.

## 4. Isolating the vocal (optional)

This separates the voice from the band **on your Mac**, with no internet. It only appears when the copy of Mimic includes the
model file. **It has never run on a Mac**, and nobody has listened to the result closely: use a song you own, about 3 to 4 minutes, and plug a laptop in.

**12. It is offered, and says what it costs.** Add clips, tick **Isolate the vocal first (AI)**.
*You should see:* "on this Mac", a size, "takes minutes", that the fans may spin up and a laptop should be plugged in,
"nothing is uploaded", and the plain warning that the result is approximate. No words about battery, a warm phone or locking the phone.
*Protects against:* a long wait you were not told about, and words written for a phone.

**13. The first run, with Wi-Fi off.** Turn Wi-Fi off, add your song with the box ticked, keep this tab in front.
*You should see:* the model is copied from the Mimic folder (the text says "copies ... from the Mimic folder"; no internet needed), then "Splitting the song", with a "minutes left"
estimate, then "Listening for the melody", then the review. By default only the **first minute** of the song is split ("How much of the song"), so also try the whole song and **write down how long the splitting took for how long a song, and which Mac.**
Afterwards Settings shows "Vocal isolation" with the model on this Mac, and a button to remove it.
*Protects against:* the page running out of memory ("Splitting the song failed"), or the browser pausing a tab you looked away from.

## 5. Practising: headphones and speakers

**14. Headphones with a microphone, sing along.** Plug in or connect the headphones, open a phrase, choose **Sing along**, click Sing.
*You should see:* the screen already says headphones are on (a wired or USB headset, "Headset", "Headphones" in the
microphone's name). A headset plugged into the 3.5 mm socket may be called **"External Microphone"** and may *not* be recognised: if you see the
headphones question, press **I have headphones on** and **write down the exact name of the microphone**, three clicks, the guide in your ears, a score within about two seconds, and a "sync offset" on the result.
**Write that number down.** While it records, **Cancel** throws the take away and **Done** scores what you sang.
*Protects against:* Mimic not recognising your headphones (it only guesses from the microphone's name; labels such as "External Microphone" were
deliberately not treated as headphones, because the same label appears for a plain microphone in the socket), and delay counted against you.

**15. AirPods.** Wear AirPods (the Mac may switch the microphone to them by itself). Open a phrase and click Sing.
*You should see:* a warning that a Bluetooth microphone is in use and that quality drops to a phone-call mode, and a button
that offers **the Mac's own microphone**. After you choose it, the guide should still play in the AirPods while the Mac records. Note the sync offset.
*Protects against:* AirPods recording at a low quality (8 to 24 kHz, mono) and adding delay, which makes tone scores unreliable and timing look bad.

**16. Headphones with no microphone, and no headphones.** (a) Put on plain wired headphones. Open a phrase.
*You should see:* Mimic cannot see them (browsers do not report them without a microphone), so it starts in **Listen, then sing**.
Choosing Sing along and clicking Sing asks first; **I have headphones on** goes ahead.
(b) Take everything off and use the Mac's speakers. Choose Sing along and click Sing.
*You should see:* a question that says the laptop or desktop speaker sits right next to the microphone, with **Listen first, then sing**
as the safe way. Then sing along with the speaker on purpose, once with your voice and once staying silent.
*Protects against:* a Mac's speaker leaking into its own microphone, which gives a confident wrong score. When you stay silent you should be
told the take sounded like the playback; when you really sing you should not.

**17. Interruptions.** During a take, (a) switch to another browser tab, (b) pull the headphones out, (c) put the Mac to sleep for a few seconds if you dare.
*You should see:* the take stops with a message that names what changed (a tab in the background, the headphones changing, the browser pausing the audio engine). Nothing is scored.
Try again works afterwards. The orange microphone dot in the menu bar goes away about 30 seconds after a normal take, or at once with **Turn off**.
*Protects against:* a take that carries on silently or leaves the microphone open.

## 6. Backup and a window of its own

**18. A backup.** Settings, Trainer, **Export my library**.
*You should see:* a file named like `mimic-library-...json` in your **Downloads** folder (the page says to look there). If Mimic had been
reminding you to back up, the reminder goes away; if it never reminded you, that is fine.
Then Delete clips and scores, **Import a backup**, and add the audio files again when it asks.
*Protects against:* a backup that was never written. The backup holds phrases and scores, never audio.

**19. Safari: Add to Dock.** With Mimic running in Safari, choose **File, Add to Dock** (macOS 14 Sonoma or newer; earlier versions do not have it).
Open the new Mimic icon from the Dock.
*You should see:* Mimic in a window of its own without tabs, and Settings saying it is running in a window of its own.
The library is **probably empty at first** (the Dock app should keep its own storage): add one clip there and check that it is still there after you quit and reopen the app.
Mimic must be running (Terminal open) the first time and whenever you update it or set up vocal isolation. After you stop it, an app or tab that is already open may keep working for a while from its saved copy: note how long, and what stops working.
*Protects against:* believing the Dock app shares your Safari clips, then losing them. If Chrome is your browser, try the install icon at the right of the address bar instead; it should share Chrome's data.

**20. Window sizes.** Make the browser window wide, then narrow it below about 720 pixels, then go full screen.
*You should see:* a bar of page names at the top when wide, a tab bar at the bottom when narrow, no text running off the edge, and the Listen / Sing buttons staying on screen.
*Protects against:* a layout that only works at one width.

## 7. Dropping files, keyboard

**21. Drop a song anywhere.** With Mimic open, drag an MP3 from Finder onto (a) the Settings page, (b) the Guide, (c) the empty space beside the Trainer list
on a wide window, (d) the Studio page, and (e) a PDF onto any page.
*You should see:* (a) to (c) open the Add clips sheet with the song waiting in it; (d) nothing happens (the Studio may be recording) but the browser does **not**
open the file; (e) nothing happens and the browser does not open the PDF. If the browser ever navigates to the file, note which page and use Back.
*Protects against:* a drop that misses the drop area replacing Mimic with the browser's own player, and losing a take.

**22. The keyboard.** On a phrase, press Tab: after the page's menu bar, the next stop is **Skip to the practice buttons**; press Return and focus lands on Sing.
Then press **Command-Return**: the count-in starts and, while you sing, Command-Return is Done. Escape cancels. In **Safari**, try Tab without Option first:
Safari may skip buttons unless you hold Option while you press Tab (or switch on "Press Tab to highlight each item on a webpage" in Safari's Advanced settings). Note what happened.
*Protects against:* a screen that needs two dozen Tab presses, or the mouse, to start a take.

## 8. Report

Settings, Trainer, **Open the device checks**, run the quick checks and the microphone and click tests, then copy or save the report.
On a Mac the phone-only list (silent switch, Siri, Home Screen) is left out. Add your Mac model, macOS version, the browser, and which headphones you used, then send me the report with
anything that did not match "You should see".
