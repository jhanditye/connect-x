# Mimic on your iPhone: the device checklist

Everything in Mimic was built and tested on a Linux computer with a desktop Chromium pretending to be an iPhone.
**It has never run on a real iPhone.** iPhone audio, files and storage behave differently from that pretend phone in
ways nobody can predict from here. This list is how you find out, in about an hour, plus one check that takes a day.

Each check says what to do, what you should see, and what it protects against, so you know why it matters. If a
check fails, do not guess: write down what you saw (the exact words on screen help most) and put it in the report
at the end.

## Before you start

- An iPhone on **iOS 16.4 or newer** (Settings, General, About). Older phones will not run the app properly.
- Open Mimic in **Safari** at its https address (not inside another app's browser, not a Private tab). A loose
  `Mimic-Vocal-Coach.html` file cannot use the microphone on an iPhone. That is an iOS rule, not a bug.
- Wired headphones with a microphone (or USB-C earbuds) **and** AirPods or another Bluetooth headset, if you have them.
- A few files in the **Files** app: one MP3 or M4A you own, one **Voice Memo** (open it, Share, Save to Files), one
  short **video** from Photos (a clip of a song you own), and a longer song (4 to 5 minutes).
- Do not use music you do not own. Mimic keeps the clips only on your phone, but the rule is yours to follow.

## 1. Install and keep your data

**1. Add to Home Screen.** In Safari: Share, Add to Home Screen, leave "Open as Web App" on. Open it from the new icon.
*You should see:* a dark "M." icon named Mimic, and the app opening full screen with no Safari bars.
*Protects against:* a plain letter icon or a missing web-app mode, which means the install settings were not read.

**2. It looks right when installed.** Check light mode and dark mode (Settings, Display), and rotate the phone.
*You should see:* readable status bar text, nothing hidden under the notch or the home bar, the bottom tabs sitting
above the home indicator, and content clear of the notch on both sides when rotated.
*Protects against:* wrong safe-area padding, which can hide buttons on a real notch (the test phone has no notch).

**3. It works with no connection.** Open Settings, scroll to "Offline and storage": it should say **Works offline: Ready**.
Then turn on airplane mode, force-quit Mimic, and open it again.
*You should see:* the app loads and your clips are listed.
*Protects against:* the offline copy not being saved, or iOS throwing it away.

**4. Your clips survive a day.** Add 3 clips, close the app, wait **a day**, open it. After a week, check again.
Also read what Settings says under "Kept safe" (Persistent, or "Best effort").
*You should see:* the same clips and scores. If it says "Best effort", note that you are in a Safari tab, not the Home Screen app.
*Protects against:* iOS clearing a website's data after about a week of not using it. Installing to the Home Screen
is meant to prevent that. This is the one thing only time can show.

## 2. Microphone

**5. The permission prompt.** Open a phrase and tap **Sing** for the first time. Allow the microphone.
Close the app completely, open it again, tap Sing. Then, in one launch, go Trainer, Studio, Trainer, Sing.
*You should see:* the prompt once, and the count-in starting right after you allow it. After that, no second prompt.
*Protects against:* the Home Screen app asking again every time (some iOS versions do), and the sound not starting
because the tap was used up by the prompt. If it asks again every time, say so: there is a fix ready to switch on.

## 3. Getting clips in

**6. From Files.** Trainer, Add clips, choose the MP3/M4A from Files.
*You should see:* a review screen with the phrases found, in a few seconds, and nothing uploaded anywhere.
*Protects against:* the iOS file picker not offering .m4a or .mp3, or the file not decoding.

**7. A Voice Memo.** Add the Voice Memo you saved to Files. Try one saved as Compressed and one as Lossless
(Settings, Voice Memos, Audio Quality).
*You should see:* both import, or a message that names what to do next.
*Protects against:* iOS Safari failing to read .m4a files from Voice Memos (a known WebKit bug, fixed only in recent iOS).

**8. A video.** Add the phone video.
*You should see:* it imports, using only the sound, and says so.
*Protects against:* .mov files being rejected, or the whole video being loaded into memory.

**9. A full song.** Add a full song you own, with instruments. On the review screen, tap "Hear the detected melody" and
compare it with "Hear the original".
*You should see:* "This is a full song" switched on by itself, a "Lead vocal" rating in words, and a melody that
follows the singing. If it follows the bass or the guitar, answer "No" to "Does the melody follow the singing?".
*Protects against:* trusting a melody that is wrong. The rating is Mimic's own guess, tested only on synthetic songs.
Tell me which song types fail (loud band, sung low, choir).

**10. A long file, and leaving mid-analysis.** Add the 4 to 5 minute song and note how long the review takes. Start it,
then switch to another app for 30 seconds and come back.
*You should see:* it finishes (or restarts cleanly) and the phone does not get hot or reload the page.
*Protects against:* iOS killing the page for using too much memory, and analysis that silently never finishes.
Also add three long songs at once, tap "Skip this file" on the first two while they are being read, and close the sheet during the third.
*You should see:* the phone cools down at once after each skip or close (the reading stops), and nothing is left running.
*Protects against:* abandoned analyses keeping the phone busy, and several songs held in memory together.
Also add a 96 kHz WAV and a very long MP3 or FLAC (over 15 minutes, if you have one).
*You should see:* the 96 kHz file reads with a moving progress bar and the screen stays responsive; the long file is refused within a second, with a message that says how to cut it down.

**11. A protected track.** If you have an Apple Music download, try to add it.
*You should see:* a plain message that it is protected and how to get a version you own.
*Protects against:* a blank screen or a spinner that never ends.

## 4. Sound and headphones

**12. The silent switch.** Flip the side switch to silent (orange showing). Open a phrase and tap **Listen**.
*You should see:* you hear the phrase. If you hear nothing, tell me; there is a one-line change.
*Protects against:* iOS muting sound that comes from a web page when the switch is on silent.

**13. Wired headphones, sing along.** Plug in the headphones, open a phrase, choose **Sing along**, tap Sing.
*You should see:* the screen already says headphones are on, three clicks, the guide in your ears, a score within about
two seconds of finishing, and a "sync offset" number on the result. Write that number down.
*Protects against:* Mimic not recognising wired headphones (it only guesses from the microphone's name), and delays
being counted against your timing.

**14. AirPods.** Wear AirPods. Open a phrase and tap Sing.
*You should see:* a warning that a Bluetooth microphone is in use and that quality drops. In Settings, choosing the
iPhone's own microphone should keep the guide in the AirPods but record with the phone. Note the sync offset.
*Protects against:* the Bluetooth headset switching to phone-call quality, and long delays making timing look bad.

**15. No headphones.** Disconnect everything. Open a phrase.
*You should see:* "Listen, then sing" already chosen. If you choose Sing along and tap Sing, it asks first;
"Listen first, then sing" starts that way, "I have headphones on" goes ahead anyway.
*Protects against:* the speaker's sound leaking into the microphone and a take that is really the original being
scored as you. Sing a phrase along with the speaker on purpose and check you are not told "this sounded like the
playback" when you did sing, and that you are told it when you stay silent.

**16. The click test.** Settings, Device checks, "Start the click test". Hold one earbud against the phone's microphone.
*You should see:* a delay in milliseconds for the route you are on. Run it for wired, AirPods and speaker.
*Protects against:* guessing the delay. These numbers are how the timing is tuned for your phone.

## 5. Interruptions

**17. A call or Siri during a take.** Tap Sing. During the clicks, call the phone, or say "Hey Siri", or let an alarm go off.
*You should see:* the take is cancelled with a message saying what to do, nothing is scored, and Try again works afterwards.
*Protects against:* a take that carries on silently, scores a recording full of a phone call, or leaves the
microphone open (the orange dot should go away).

**18. Leaving mid-take, and mid-analysis.** Tap Sing, then swipe to another app. Come back. Then do it again but leave
just after you stop singing, while it says "Analysing".
*You should see:* the first is cancelled with a message. The second either shows the result or asks you to try again,
never a frozen screen.
*Protects against:* iOS pausing the page, and a result that never arrives.

**19. Lock screen.** Sing, and press the side button during the take. Also let the phone sit on a phrase for the Auto-Lock time.
*You should see:* a cancelled take with a message, and during a normal practice visit the screen stays on.
*Protects against:* the screen locking while you sing, and a locked phone leaving the microphone open.

**20. Pulling the headphones out mid-take.** Unplug wired headphones during a take.
*You should see:* the take stops with a message, and the screen shows the new route.
*Protects against:* the sound suddenly coming out of the speaker into the microphone.

## 6. Scores on a real voice

Pick a phrase from a clip you like and sing it for real.

**21. A careful copy.** Sing the phrase as closely as you can.
*You should see:* a score you agree with (a close copy usually lands in the 70s to 90s), notes marked where you were off,
and fixes that make sense when you listen to "You" next to "Original".
*Protects against:* a scorer tuned only on computer-made voices. If a copy you are sure about gets under 50, or a bad
one gets over 90, **tell me which phrase and the score**. That is the most useful thing you can send back.

**22. Honest failures.** Stay silent once. Sing a completely different tune once. Sing the phrase an octave lower once.
*You should see:* silence and the different tune are "not scored" and do not appear in your history; the octave lower
is not marked down.
*Protects against:* fake progress from takes that are not real attempts.

**23. How long the result takes.** Time it from the moment you stop singing to the score.
*You should see:* about two seconds or less on a recent iPhone. Write down your model and the time.
*Protects against:* a slow older phone making the app feel stuck. The test computer takes about half a second.

## 7. Backup and tidy-up

**24. A backup.** Settings, Export my library. Save it to Files.
*You should see:* the share sheet opens and "Save to Files" works. The Today screen stops asking for a backup.
Then Delete all clips and scores, Import a backup, and add the audio file again when it asks.
*You should see:* your phrases, scores and singer choices come back; the clips ask for their audio files by name.
*Protects against:* iOS not letting a Home Screen app save a file (a known risk). The backup never contains audio.
Two honest messages to look for: if the share sheet does not open on the first tap the page says "Tap the same button again to finish" (the second tap must open it), and if the phone can only start a download it says it cannot tell whether the file was saved and tells you to look in Files, Downloads.
*You should see:* in both cases the backup reminder on the Today screen stays on, and it goes off only after Save to Files (or another choice in the share sheet) was completed.
*Protects against:* being told "Backup saved" when no file exists, then deleting everything.

**25. An update.** After a new version is published, open the app twice.
*You should see:* a banner "A new version of Mimic is ready"; tapping Update now reloads once.
*Protects against:* an old copy staying on the phone forever.

## Send the report back

1. Settings, Device checks (or More, "Run the device checks").
2. Tap **Run the quick checks**. Then do the microphone and click tests in step 2 while wearing the headphones
   you normally use.
3. In step 3, "On your iPhone", answer each line that matches a check above (it did it, it did not, skipped).
4. Add your iPhone model, iOS version, and which headphones you used in the notes box.
5. Tap **Copy the report** (or Save) and send it to whoever is helping you. It holds numbers and words only: no audio,
   no recordings and no clip names. Read it first if you like.

If something fails before you can open the Device checks, just send what the screen said and what you tapped.

## If you use the native app instead (ios-native)

Do the same checks, except 1 to 3 (there is no Home Screen install and no service worker inside the app). Add:
the microphone prompt should appear **once** and be remembered in Settings, Mimic; the backup in check 24 may not open
the share sheet inside the app (a known gap, listed in `ios-native/README.md`). The native app has never been built on a Mac
either, so tell me first if Xcode fails.
