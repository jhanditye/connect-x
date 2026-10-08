// The notice that must travel with Spleeter, and the plain-English facts about the model, for the Guide and Settings.
// Spleeter's code is MIT-licensed; Deezer's README and LICENSE state no separate licence for the pretrained weights and say the
// weights were trained on a private dataset, so the app says so too instead of claiming more.

export const SPLEETER_NAME = 'Spleeter';
export const SPLEETER_URL = 'https://github.com/deezer/spleeter';

/** The MIT licence text of Deezer's Spleeter, verbatim, as its LICENSE file gives it. */
export const SPLEETER_MIT_NOTICE = `MIT License

Copyright (c) 2019-present, Deezer SA.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

/** What the app says about where the model comes from and what is and is not known about its licence. */
export const SPLEETER_SUMMARY =
  'Vocal isolation uses Spleeter (2 stems) by Deezer, converted to run in your browser. Spleeter\'s code is MIT-licensed. Deezer publishes the trained model without a separate licence of its own and says it was trained on a private dataset; that is not legal advice, so check it before you share this app publicly. Deezer asks that you only use Spleeter on copyrighted material you have permission to use. The runtime is onnxruntime-web (MIT, Microsoft).';
