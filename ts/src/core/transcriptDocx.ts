// The parts of a minimal .docx (WordprocessingML) for a transcript: a title paragraph and one
// paragraph per piece, the [hh:mm:ss] mark in grey when timestamps are on. No dependency: the
// caller zips these parts (src/main/file/transcriptExport.ts). Opens in Word and LibreOffice.

import { speakerPrefix } from './diarize';
import { clock, type TranscriptSegment } from './transcriptFormat';

/** XML text: escapes markup and drops characters XML 1.0 does not allow. */
export function xmlText(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const run = (text: string, props = '') =>
  `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${xmlText(text)}</w:t></w:r>`;

function paragraph(runs: string, props = ''): string {
  return `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ''}${runs}</w:p>`;
}

/** word/document.xml for the transcript. */
export function documentXml(segments: readonly TranscriptSegment[], timestamps: boolean, title: string): string {
  const body: string[] = [];
  const heading = title.replace(/\s+/g, ' ').trim() || 'Transcript';
  body.push(paragraph(run(heading, '<w:b/><w:sz w:val="32"/>'), '<w:spacing w:after="240"/>'));
  for (const seg of segments) {
    const words = (seg.text ?? '').replace(/\s*\r?\n\s*/g, ' ').trim();
    if (!words) continue;
    const text = speakerPrefix(seg.speaker) + words;
    const runs = timestamps ? run(`[${clock(seg.start)}] `, '<w:color w:val="808080"/>') + run(text) : run(text);
    body.push(paragraph(runs, '<w:spacing w:after="120"/>'));
  }
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${body.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>` +
    '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="709" w:footer="709" w:gutter="0"/>' +
    '</w:sectPr></w:body></w:document>'
  );
}

/** All parts of the package, in the order they are zipped ([Content_Types].xml first). */
export function docxParts(
  segments: readonly TranscriptSegment[],
  timestamps: boolean,
  title: string,
): { name: string; xml: string }[] {
  return [
    {
      name: '[Content_Types].xml',
      xml:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '</Types>',
    },
    {
      name: '_rels/.rels',
      xml:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        '</Relationships>',
    },
    { name: 'word/document.xml', xml: documentXml(segments, timestamps, title) },
  ];
}
