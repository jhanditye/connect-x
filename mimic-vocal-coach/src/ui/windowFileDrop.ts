// A file dropped anywhere on the window must never make the browser open it in place of Mimic: on a computer the singer drags a
// song out of Finder, and a drop that misses the drop area (another page, the margin beside the Trainer, a PDF) used to navigate the
// tab to the audio file or the PDF and throw away whatever was on screen. This is the catch-all at the bottom: the areas that take
// files themselves call preventDefault first and are left alone; everything else is stopped here, and songs are handed to the
// Add clips sheet.
//
// Screens where a take may be under way (the Studio, the drills, a phrase being sung) only have the drop swallowed: moving to the
// Add clips sheet from there would end the take.

import { looksLikeMedia } from '../audio/decode';
import { goTrainer, parseRoute, parseTrainerPath, type Route } from '../state/routing';
import { shouldBlockLeave } from './leaveGuard';
import { setPendingImport } from './trainerHandoff';

type Take = (files: File[]) => void;

let sheetTake: Take | null = null;

/** The open Add clips sheet registers here to take files dropped outside its own drop area. Returns the function that removes it. */
export function setSheetDropTarget(take: Take | null): () => void {
  sheetTake = take;
  return () => {
    if (sheetTake === take) sheetTake = null;
  };
}

/** Screens that may be recording or playing along, where a drop is ignored instead of moving to another screen. */
const KEEP_HERE: readonly Route[] = ['studio', 'practice'];

function carriesFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files');
}

/** Whether a dropped song may be taken now: the library is open, and the screen is not one where a take may be under way. */
function mayTake(libraryReady: () => boolean): boolean {
  if (!libraryReady()) return false;
  const hash = window.location.hash;
  if (KEEP_HERE.includes(parseRoute(hash))) return false;
  if (parseRoute(hash) === 'trainer' && parseTrainerPath(hash).view === 'phrase') return false;
  return true;
}

/** Installs the catch-all on the window. `libraryReady` says whether the Trainer library can take clips. Returns the remover. */
export function installWindowFileDrop(libraryReady: () => boolean, target: Window = window): () => void {
  const onDragOver = (e: DragEvent) => {
    if (e.defaultPrevented || !carriesFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = mayTake(libraryReady) ? 'copy' : 'none';
  };
  const onDrop = (e: DragEvent) => {
    if (e.defaultPrevented || !carriesFiles(e)) return;
    e.preventDefault(); // the browser must not open the dropped file
    if (!mayTake(libraryReady)) return;
    const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => looksLikeMedia(f));
    if (files.length === 0) return;
    if (sheetTake) {
      sheetTake(files);
      return;
    }
    if (shouldBlockLeave('#trainer/add')) return;
    setPendingImport(files);
    goTrainer({ view: 'add' });
  };
  target.addEventListener('dragover', onDragOver);
  target.addEventListener('drop', onDrop);
  return () => {
    target.removeEventListener('dragover', onDragOver);
    target.removeEventListener('drop', onDrop);
  };
}
