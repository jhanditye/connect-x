// Web Worker entry: renders a slowed and/or transposed guide off the main thread.
// in:  RenderRequest   out: RenderResponse (see stretchProtocol.ts)

import { runRenderJob, type RenderRequest, type RenderResponse } from './stretchProtocol';

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = (event: MessageEvent<RenderRequest>) => {
  runRenderJob(event.data, (msg: RenderResponse) => {
    if (msg.type === 'result') scope.postMessage(msg, [msg.samples.buffer]);
    else scope.postMessage(msg);
  });
};

// "I am alive": the client falls back to rendering in slices on the main thread when it never hears this.
scope.postMessage({ type: 'alive' } satisfies RenderResponse);
