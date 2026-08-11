import { useCallback, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  BookOpen,
  CheckCircle2,
  Download,
  FileText,
  ImagePlus,
  Info,
  ListTree,
  RefreshCw,
  Settings2,
  UploadCloud,
  X,
} from 'lucide-react';

type DetectionMethod = 'auto' | 'chinese' | 'english' | 'separators' | 'fixed' | 'manual';

type Chapter = {
  number: number;
  title: string;
  characters: number;
  content: string;
};

type DetectionSettings = {
  method: DetectionMethod;
  minBlankLines: number;
  linesPerChapter: number;
};

type HeadingCandidate = {
  lineIndex: number;
  number: number;
  title: string;
  kind: 'chinese' | 'english';
  raw: string;
};

type DetectionResult = {
  chapters: Chapter[];
  usedHeadings: boolean;
  fallbackReason?: string;
};

const methodOptions: Array<{ value: DetectionMethod; label: string }> = [
  { value: 'auto', label: 'Auto' },
  { value: 'chinese', label: 'Chinese chapters' },
  { value: 'english', label: 'English chapters' },
  { value: 'separators', label: 'Separators' },
  { value: 'fixed', label: 'Fixed lines' },
  { value: 'manual', label: 'Manual' },
];

function chineseNumeralToNumber(value: string): number | null {
  if (/^\d+$/.test(value)) return Number(value);
  const digitMap: Record<string, number> = {
    零: 0,
    〇: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  const unitMap: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: 10000 };
  let total = 0;
  let section = 0;
  let number = 0;
  for (const char of value) {
    if (char in digitMap) {
      number = digitMap[char];
    } else if (char in unitMap) {
      const unit = unitMap[char];
      if (unit === 10000) {
        section = (section + number) * unit;
        total += section;
        section = 0;
      } else {
        section += (number || 1) * unit;
      }
      number = 0;
    } else {
      return null;
    }
  }
  return total + section + number;
}

function parseHeading(line: string, lineIndex: number): HeadingCandidate | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 140) return null;

  const chineseMatch = trimmed.match(
    /^第\s*([0-9零〇一二三四五六七八九十百千万两]+)\s*章(?:\s*[:：.．、\-—]\s*|\s+)?(.*?)\s*$/i,
  );
  if (chineseMatch) {
    const chapterNumber = chineseNumeralToNumber(chineseMatch[1]);
    if (chapterNumber && chapterNumber > 0) {
      return {
        lineIndex,
        number: chapterNumber,
        title: chineseMatch[2].trim() || `第${chineseMatch[1]}章`,
        kind: 'chinese',
        raw: trimmed,
      };
    }
  }

  const englishMatch = trimmed.match(
    /^chapter\s+(\d+)\b(?:\s*[:：.．、\-—]\s*|\s+)?(.*?)\s*$/i,
  );
  if (englishMatch) {
    const chapterNumber = Number(englishMatch[1]);
    if (chapterNumber > 0) {
      return {
        lineIndex,
        number: chapterNumber,
        title: englishMatch[2].trim() || `Chapter ${chapterNumber}`,
        kind: 'english',
        raw: trimmed,
      };
    }
  }
  return null;
}

function findReliableHeadings(lines: string[], method: DetectionMethod): HeadingCandidate[] {
  const all = lines
    .map((line, lineIndex) => parseHeading(line, lineIndex))
    .filter((candidate): candidate is HeadingCandidate => candidate !== null);
  const candidates =
    method === 'chinese'
      ? all.filter((candidate) => candidate.kind === 'chinese')
      : method === 'english'
        ? all.filter((candidate) => candidate.kind === 'english')
        : all;

  if (candidates.length === 0) return [];
  const sequences: HeadingCandidate[][] = [];
  candidates.forEach((start, startIndex) => {
    const sequence = [start];
    let expected = start.number + 1;
    for (let index = startIndex + 1; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      if (candidate.number === expected) {
        sequence.push(candidate);
        expected += 1;
      }
    }
    sequences.push(sequence);
  });
  sequences.sort(
    (first, second) =>
      second.length - first.length || first[0].lineIndex - second[0].lineIndex,
  );
  const best = sequences[0];
  if (best.length >= 2) return best;
  if (candidates.length === 1 && candidates[0].number === 1 && candidates[0].lineIndex <= 2) {
    return candidates;
  }
  return [];
}

function chaptersFromHeadings(lines: string[], headings: HeadingCandidate[]): Chapter[] {
  return headings.map((heading, index) => {
    const end = headings[index + 1]?.lineIndex ?? lines.length;
    const fullContent = lines.slice(heading.lineIndex, end).join('\n').trim();
    const content = lines.slice(heading.lineIndex + 1, end).join('\n').trim();
    return {
      number: heading.number,
      title: heading.title,
      characters: fullContent.length,
      content,
    };
  });
}

function chaptersFromRanges(lines: string[], ranges: Array<[number, number]>, titlePrefix: string): Chapter[] {
  return ranges
    .map(([start, end], index) => {
      const content = lines.slice(start, end).join('\n').trim();
      if (!content) return null;
      const firstLine = lines.slice(start, end).find((line) => line.trim())?.trim() || '';
      return {
        number: index + 1,
        title: firstLine.length <= 72 ? firstLine : `${titlePrefix} ${index + 1}`,
        characters: content.length,
        content,
      };
    })
    .filter((chapter): chapter is Chapter => chapter !== null);
}

function chaptersBySeparators(lines: string[], minBlankLines: number): Chapter[] {
  const ranges: Array<[number, number]> = [];
  let start = 0;
  let blankCount = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim()) {
      blankCount += 1;
    } else if (blankCount >= minBlankLines) {
      ranges.push([start, index - blankCount]);
      start = index;
      blankCount = 0;
    } else {
      blankCount = 0;
    }
  }
  ranges.push([start, lines.length]);
  return chaptersFromRanges(lines, ranges, 'Section');
}

function chaptersByFixedLines(lines: string[], linesPerChapter: number): Chapter[] {
  const safeSize = Math.max(1, linesPerChapter);
  const ranges: Array<[number, number]> = [];
  for (let start = 0; start < lines.length; start += safeSize) {
    ranges.push([start, Math.min(start + safeSize, lines.length)]);
  }
  return chaptersFromRanges(lines, ranges, 'Part');
}

function detectChapters(text: string, settings: DetectionSettings): DetectionResult {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  // Fixed lines are deliberately a fallback. A reliable chapter sequence
  // must win so long Chinese novels are not sliced into arbitrary chunks.
  const shouldTryHeadings =
    settings.method === 'auto' ||
    settings.method === 'chinese' ||
    settings.method === 'english' ||
    settings.method === 'fixed';
  if (shouldTryHeadings) {
    const headingMethod = settings.method === 'fixed' ? 'auto' : settings.method;
    const headings = findReliableHeadings(lines, headingMethod);
    if (headings.length > 0) {
      return { chapters: chaptersFromHeadings(lines, headings), usedHeadings: true };
    }
  }

  if (settings.method === 'separators') {
    const chapters = chaptersBySeparators(lines, settings.minBlankLines);
    return {
      chapters,
      usedHeadings: false,
      fallbackReason: chapters.length > 1
        ? `Split at runs of ${settings.minBlankLines} blank lines.`
        : 'No separator pattern was strong enough, so the file stays as one section.',
    };
  }

  const chapters = chaptersByFixedLines(lines, settings.linesPerChapter);
  return {
    chapters,
    usedHeadings: false,
    fallbackReason:
      settings.method === 'manual'
        ? `Manual mode has no marked boundaries yet; showing ${settings.linesPerChapter}-line fallback sections.`
        : `No reliable chapter sequence found; showing ${settings.linesPerChapter}-line fallback sections.`,
  };
}

function formatCount(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function escapeHtml(value: string): string {
  return escapeXml(value).replace(/\n/g, '<br />');
}

function safeFilename(value: string): string {
  const normalized = value.trim().replace(/[^\p{L}\p{N}\s_-]+/gu, '').trim();
  return (normalized || 'book').replace(/\s+/g, '_').slice(0, 120);
}

function getImageMimeType(file: File): string {
  if (file.type === 'image/jpeg' || /\.jpe?g$/i.test(file.name)) return 'image/jpeg';
  if (file.type === 'image/gif' || /\.gif$/i.test(file.name)) return 'image/gif';
  if (file.type === 'image/webp' || /\.webp$/i.test(file.name)) return 'image/webp';
  return 'image/png';
}

type ZipEntry = {
  name: string;
  data: Uint8Array;
};

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeUint16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true);
}

function writeUint32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value >>> 0, true);
}

function createZip(entries: ZipEntry[]): Blob {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;
  const encoder = new TextEncoder();

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const checksum = crc32(entry.data);
    const local = new Uint8Array(30 + name.length);
    const localView = new DataView(local.buffer);
    writeUint32(localView, 0, 0x04034b50);
    writeUint16(localView, 4, 20);
    writeUint16(localView, 6, 0x800);
    writeUint16(localView, 8, 0);
    writeUint16(localView, 10, 0);
    writeUint16(localView, 12, 0);
    writeUint32(localView, 14, checksum);
    writeUint32(localView, 18, entry.data.length);
    writeUint32(localView, 22, entry.data.length);
    writeUint16(localView, 26, name.length);
    local.set(name, 30);
    localParts.push(local, entry.data);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    writeUint32(centralView, 0, 0x02014b50);
    writeUint16(centralView, 4, 20);
    writeUint16(centralView, 6, 20);
    writeUint16(centralView, 8, 0x800);
    writeUint16(centralView, 10, 0);
    writeUint16(centralView, 12, 0);
    writeUint16(centralView, 14, 0);
    writeUint32(centralView, 16, checksum);
    writeUint32(centralView, 20, entry.data.length);
    writeUint32(centralView, 24, entry.data.length);
    writeUint16(centralView, 28, name.length);
    writeUint32(centralView, 42, offset);
    central.set(name, 46);
    centralParts.push(central);
    offset += local.length + entry.data.length;
  }

  const centralDirectorySize = centralParts.reduce((total, part) => total + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  writeUint32(endView, 0, 0x06054b50);
  writeUint16(endView, 8, entries.length);
  writeUint16(endView, 10, entries.length);
  writeUint32(endView, 12, centralDirectorySize);
  writeUint32(endView, 16, offset);
  writeUint16(endView, 20, 0);

  const totalSize =
    localParts.reduce((total, part) => total + part.length, 0) +
    centralDirectorySize +
    end.length;
  const combined = new Uint8Array(totalSize);
  let cursor = 0;
  for (const part of [...localParts, ...centralParts, end]) {
    combined.set(part, cursor);
    cursor += part.length;
  }
  return new Blob([combined.buffer as ArrayBuffer], { type: 'application/epub+zip' });
}

async function createEpub(
  title: string,
  author: string,
  language: string,
  chapters: Chapter[],
  coverFile?: File,
): Promise<Blob> {
  const bookTitle = title.trim() || 'Untitled Book';
  const bookAuthor = author.trim() || 'Unknown author';
  const safeLanguage = language.trim() || 'en';
  const bookId = `urn:uuid:${crypto.randomUUID()}`;
  const encoder = new TextEncoder();
  const entries: ZipEntry[] = [
    { name: 'mimetype', data: encoder.encode('application/epub+zip') },
    {
      name: 'META-INF/container.xml',
      data: encoder.encode(
        '<?xml version="1.0" encoding="UTF-8"?>' +
          '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">' +
          '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>' +
          '</container>',
      ),
    },
  ];

  const chapterFiles = chapters.map((chapter, index) => {
    const href = `chapter-${index + 1}.xhtml`;
    const body = chapter.content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => `<p>${escapeHtml(line)}</p>`)
      .join('');
    return {
      href,
      id: `chapter-${index + 1}`,
      content: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="${escapeXml(safeLanguage)}">
<head><title>${escapeXml(chapter.title)}</title><meta charset="UTF-8"/></head>
<body><h1>${escapeXml(chapter.title)}</h1>${body || '<p></p>'}</body>
</html>`,
    };
  });

  for (const chapter of chapterFiles) {
    entries.push({ name: `OEBPS/${chapter.href}`, data: encoder.encode(chapter.content) });
  }

  let coverItem = '';
  let coverManifest = '';
  let coverSpine = '';
  if (coverFile) {
    const imageData = new Uint8Array(await coverFile.arrayBuffer());
    const mimeType = getImageMimeType(coverFile);
    const extension = mimeType === 'image/jpeg' ? 'jpg' : mimeType.split('/')[1];
    entries.push({ name: `OEBPS/images/cover.${extension}`, data: imageData });
    entries.push({
      name: 'OEBPS/cover.xhtml',
      data: encoder.encode(
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="${escapeXml(safeLanguage)}">
<head><title>${escapeXml(bookTitle)}</title></head>
<body><img src="images/cover.${extension}" alt="${escapeXml(bookTitle)}"/></body>
</html>`,
      ),
    });
    coverItem = `<meta name="cover" content="cover-image"/>`;
    coverManifest = `<item id="cover-image" href="images/cover.${extension}" media-type="${mimeType}" properties="cover-image"/><item id="cover-page" href="cover.xhtml" media-type="application/xhtml+xml"/>`;
    coverSpine = '<itemref idref="cover-page" linear="no"/>';
  }

  const manifest = [
    '<item id="nav" properties="nav" href="nav.xhtml" media-type="application/xhtml+xml"/>',
    '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
    coverManifest,
    ...chapterFiles.map(
      (chapter) => `<item id="${chapter.id}" href="${chapter.href}" media-type="application/xhtml+xml"/>`,
    ),
  ].join('');
  const spine = `${coverSpine}${chapterFiles.map((chapter) => `<itemref idref="${chapter.id}"/>`).join('')}`;
  const tocLinks = chapterFiles
    .map((chapter, index) => `<li><a href="${chapter.href}">${escapeHtml(chapters[index].title)}</a></li>`)
    .join('');
  const nav = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${escapeXml(safeLanguage)}">
<head><title>${escapeXml(bookTitle)}</title></head>
<body><nav epub:type="toc" id="toc"><h1>Table of Contents</h1><ol>${tocLinks}</ol></nav></body>
</html>`;
  const ncxPoints = chapterFiles
    .map(
      (chapter, index) =>
        `<navPoint id="navPoint-${index + 1}" playOrder="${index + 1}"><navLabel><text>${escapeXml(chapters[index].title)}</text></navLabel><content src="${chapter.href}"/></navPoint>`,
    )
    .join('');
  const ncx = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head><meta name="dtb:uid" content="${escapeXml(bookId)}"/></head>
<docTitle><text>${escapeXml(bookTitle)}</text></docTitle>
<navMap>${ncxPoints}</navMap>
</ncx>`;
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="book-id">${escapeXml(bookId)}</dc:identifier>
<dc:title>${escapeXml(bookTitle)}</dc:title>
<dc:creator>${escapeXml(bookAuthor)}</dc:creator>
<dc:language>${escapeXml(safeLanguage)}</dc:language>
<meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}</meta>
${coverItem}
</metadata>
<manifest>${manifest}</manifest>
<spine toc="ncx">${spine}</spine>
</package>`;

  entries.push(
    { name: 'OEBPS/nav.xhtml', data: encoder.encode(nav) },
    { name: 'OEBPS/toc.ncx', data: encoder.encode(ncx) },
    { name: 'OEBPS/content.opf', data: encoder.encode(opf) },
  );
  return createZip(entries);
}

function App() {
  const inputRef = useRef<HTMLInputElement>(null);
  const coverInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [isReading, setIsReading] = useState(false);
  const [fileError, setFileError] = useState('');
  const [coverFile, setCoverFile] = useState<File | undefined>();
  const [bookTitle, setBookTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [language, setLanguage] = useState('zh-CN');
  const [isConverting, setIsConverting] = useState(false);
  const [epubBlob, setEpubBlob] = useState<Blob | null>(null);
  const [epubFilename, setEpubFilename] = useState('');
  const [exportError, setExportError] = useState('');
  const [detectionVersion, setDetectionVersion] = useState(0);
  const [settings, setSettings] = useState<DetectionSettings>({
    method: 'auto',
    minBlankLines: 2,
    linesPerChapter: 40,
  });

  const result = useMemo(
    () => (text ? detectChapters(text, settings) : { chapters: [], usedHeadings: false }),
    [text, settings, detectionVersion],
  );

  const readFile = useCallback((nextFile: File) => {
    setFileError('');
    if (!/\.txt$/i.test(nextFile.name)) {
      setFileError('Only .txt files are supported in this first slice.');
      return;
    }
    setIsReading(true);
    const reader = new FileReader();
    reader.onload = () => {
      const contents = typeof reader.result === 'string' ? reader.result : '';
      setFile(nextFile);
      setText(contents);
      setBookTitle((current) => current || nextFile.name.replace(/\.txt$/i, ''));
      setEpubBlob(null);
      setEpubFilename('');
      setExportError('');
      setIsReading(false);
    };
    reader.onerror = () => {
      setFileError('This file could not be read locally. Try saving it as UTF-8 and upload again.');
      setIsReading(false);
    };
    reader.readAsText(nextFile);
  }, []);

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    const droppedFile = event.dataTransfer.files[0];
    if (droppedFile) readFile(droppedFile);
  };

  const clearFile = () => {
    setFile(null);
    setText('');
    setFileError('');
    setCoverFile(undefined);
    setEpubBlob(null);
    setEpubFilename('');
    setExportError('');
    setBookTitle('');
    setAuthor('');
    if (inputRef.current) inputRef.current.value = '';
    if (coverInputRef.current) coverInputRef.current.value = '';
  };

  const updateSetting = <K extends keyof DetectionSettings>(key: K, value: DetectionSettings[K]) => {
    setSettings((current) => ({ ...current, [key]: value }));
    setEpubBlob(null);
    setEpubFilename('');
  };

  const convertToEpub = async () => {
    if (!result.chapters.length) return;
    setIsConverting(true);
    setExportError('');
    try {
      const blob = await createEpub(bookTitle, author, language, result.chapters, coverFile);
      setEpubBlob(blob);
      setEpubFilename(`${safeFilename(bookTitle || file?.name.replace(/\.txt$/i, '') || 'book')}.epub`);
    } catch {
      setEpubBlob(null);
      setEpubFilename('');
      setExportError('EPUB creation failed. Please try again with a smaller cover image.');
    } finally {
      setIsConverting(false);
    }
  };

  const downloadEpub = () => {
    if (!epubBlob || !epubFilename) return;
    const url = URL.createObjectURL(epubBlob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = epubFilename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <main className="app-shell">
      <div className="app-container">
        <header className="topbar">
          <div className="flex items-center gap-3">
            <span className="brand-mark" aria-hidden="true">
              <BookOpen size={18} strokeWidth={2.2} />
            </span>
            <div>
              <div className="text-sm font-bold tracking-tight">Leafline</div>
              <div className="mono text-[10px] uppercase tracking-[.14em] text-muted-foreground">TXT → EPUB</div>
            </div>
          </div>
          <div className="hidden items-center gap-2 text-xs text-muted-foreground sm:flex">
            <span className="h-1.5 w-1.5 rounded-full bg-primary" />
            Runs in your browser
          </div>
        </header>

        <section className="fade-up pb-10 pt-14 sm:pb-14 sm:pt-20">
          <div className="eyebrow mb-4">A quieter way to prepare a book</div>
          <h1 className="hero-title">
            Turn a long text file into a <em>clear chapter map.</em>
          </h1>
          <p className="hero-copy mt-6">
            Leafline reads your novel locally, recognizes Chinese and English chapter headings,
            and gives you a calm split preview before any book is made.
          </p>
        </section>

        {!file ? (
          <section className="panel fade-up delay-1 mx-auto max-w-3xl p-4 sm:p-6">
            <div
              className={`dropzone ${isDragging ? 'is-dragging' : ''}`}
              onDragEnter={(event) => {
                event.preventDefault();
                setIsDragging(true);
              }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={(event) => {
                if (event.currentTarget === event.target) setIsDragging(false);
              }}
              onDrop={handleDrop}
              tabIndex={0}
              role="button"
              aria-label="Choose a TXT file"
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') inputRef.current?.click();
              }}
              data-testid="dropzone-upload"
            >
              <div className="drop-icon">
                <UploadCloud size={25} strokeWidth={1.7} />
              </div>
              <h2 className="mt-5 text-lg font-semibold">Drop your novel here</h2>
              <p className="mt-1 text-center text-sm text-muted-foreground">
                or choose a plain text file from your device
              </p>
              <button
                type="button"
                className="btn-primary mt-6"
                onClick={() => inputRef.current?.click()}
                data-testid="button-choose-file"
              >
                <FileText size={16} />
                Choose .txt file
                <ArrowRight size={15} />
              </button>
              <input
                ref={inputRef}
                className="sr-only"
                type="file"
                accept=".txt,text/plain"
                onChange={(event) => {
                  const selected = event.target.files?.[0];
                  if (selected) readFile(selected);
                }}
                data-testid="input-file-upload"
              />
            </div>
            {isReading && (
              <div className="mt-4 flex items-center gap-3 rounded-lg bg-secondary/60 px-3 py-2 text-sm text-muted-foreground" data-testid="status-reading">
                <span className="h-2 w-2 animate-pulse rounded-full bg-primary" />
                Reading the file locally…
              </div>
            )}
            {fileError && (
              <div className="notice mt-4" role="alert" data-testid="status-file-error">
                <AlertCircle size={16} />
                <span>{fileError}</span>
              </div>
            )}
            <div className="mt-5 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5"><CheckCircle2 size={14} className="text-primary" /> Local-only reading</span>
              <span className="inline-flex items-center gap-1.5"><CheckCircle2 size={14} className="text-primary" /> Chinese &amp; English headings</span>
              <span className="inline-flex items-center gap-1.5"><CheckCircle2 size={14} className="text-primary" /> No upload required</span>
            </div>
          </section>
        ) : (
          <section className="fade-up delay-1 pb-16">
            <div className="mb-5 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="file-pill min-w-0">
                <span className="file-type">TXT</span>
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold" data-testid="text-filename">{file.name}</div>
                  <div className="mono mt-0.5 text-xs text-muted-foreground" data-testid="text-file-meta">
                    {formatBytes(file.size)} · {formatCount(text.length)} characters
                  </div>
                </div>
                <button
                  type="button"
                  className="btn-quiet ml-auto min-h-9 px-2"
                  onClick={clearFile}
                  aria-label="Remove current file"
                  data-testid="button-remove-file"
                >
                  <X size={17} />
                </button>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="hidden text-xs text-muted-foreground md:inline">Change source file</span>
                <button type="button" className="btn-secondary" onClick={() => inputRef.current?.click()} data-testid="button-change-file">
                  <RefreshCw size={15} />
                  Change file
                </button>
                <input
                  ref={inputRef}
                  className="sr-only"
                  type="file"
                  accept=".txt,text/plain"
                  onChange={(event) => {
                    const selected = event.target.files?.[0];
                    if (selected) readFile(selected);
                  }}
                  data-testid="input-change-file"
                />
              </div>
            </div>

            <div className="grid gap-5 lg:grid-cols-[330px_minmax(0,1fr)]">
              <aside className="panel fade-up delay-2 h-fit p-5">
                <div className="mb-5 flex items-start justify-between">
                  <div>
                    <div className="eyebrow mb-1">Chapter map</div>
                    <h2 className="text-lg font-semibold">Detection settings</h2>
                  </div>
                  <Settings2 size={19} className="text-muted-foreground" />
                </div>

                <div className="mb-5">
                  <label className="setting-label" htmlFor="detection-method">Detection method</label>
                  <div className="method-grid" id="detection-method">
                    {methodOptions.map((option) => (
                      <div className="method-option" key={option.value}>
                        <input
                          id={`method-${option.value}`}
                          type="radio"
                          name="detection-method"
                          value={option.value}
                          checked={settings.method === option.value}
                          onChange={() => updateSetting('method', option.value)}
                          data-testid={`input-method-${option.value}`}
                        />
                        <label htmlFor={`method-${option.value}`}>{option.label}</label>
                      </div>
                    ))}
                  </div>
                  <span className="setting-hint">
                    Auto checks a reliable numbered heading sequence before using a fallback.
                  </span>
                </div>

                <div className="settings-layout mb-5">
                  <div>
                    <label className="setting-label" htmlFor="blank-lines">Min blank lines</label>
                    <select
                      id="blank-lines"
                      className="setting-control"
                      value={settings.minBlankLines}
                      onChange={(event) => updateSetting('minBlankLines', Number(event.target.value))}
                      data-testid="select-min-blank-lines"
                    >
                      {[1, 2, 3, 4].map((value) => <option key={value} value={value}>{value}</option>)}
                    </select>
                    <span className="setting-hint">Used by Separators.</span>
                  </div>
                  <div>
                    <label className="setting-label" htmlFor="lines-per-chapter">Lines per chapter</label>
                    <input
                      id="lines-per-chapter"
                      className="setting-control"
                      type="number"
                      min={1}
                      max={10000}
                      value={settings.linesPerChapter}
                      onChange={(event) => updateSetting('linesPerChapter', Math.max(1, Number(event.target.value) || 1))}
                      data-testid="input-lines-per-chapter"
                    />
                    <span className="setting-hint">Fallback only.</span>
                  </div>
                </div>

                <button
                  type="button"
                  className="btn-primary w-full"
                  onClick={() => {
                    setDetectionVersion((current) => current + 1);
                    setEpubBlob(null);
                    setEpubFilename('');
                  }}
                  data-testid="button-redetect"
                >
                  <RefreshCw size={16} />
                  Re-detect chapters
                </button>
                <div className="notice mt-4">
                  <Info size={15} />
                  <span>Your text and cover stay in this browser while the EPUB is assembled.</span>
                </div>
              </aside>

              <section className="panel fade-up delay-3 min-w-0 p-5 sm:p-6">
                <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
                  <div>
                    <div className="eyebrow mb-1">Live split preview</div>
                    <h2 className="text-xl font-semibold tracking-tight">What your book will contain</h2>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="h-2 w-2 rounded-full bg-primary" />
                    Updates as settings change
                  </div>
                </div>

                <div className="mt-6 grid grid-cols-2 gap-2 sm:grid-cols-3">
                  <div className="panel-soft p-3.5">
                    <div className="stat-value" data-testid="text-total-chapters">{formatCount(result.chapters.length)}</div>
                    <div className="stat-label mt-1">Chapters</div>
                  </div>
                  <div className="panel-soft p-3.5">
                    <div className="stat-value" data-testid="text-total-characters">{formatCount(text.length)}</div>
                    <div className="stat-label mt-1">Characters</div>
                  </div>
                  <div className="panel-soft col-span-2 p-3.5 sm:col-span-1">
                    <div className="stat-value">{result.usedHeadings ? 'Headings' : 'Fallback'}</div>
                    <div className="stat-label mt-1">Boundary source</div>
                  </div>
                </div>

                {result.fallbackReason && (
                  <div className="notice mt-5" data-testid="status-fallback">
                    <Info size={15} />
                    <span>{result.fallbackReason}</span>
                  </div>
                )}

                <div className="mt-6 flex items-center justify-between border-b border-border pb-3">
                  <div className="flex items-center gap-2 text-sm font-semibold">
                    <ListTree size={16} className="text-primary" />
                    Detected chapters
                  </div>
                  <span className="mono text-xs text-muted-foreground">{formatCount(result.chapters.length)} items</span>
                </div>

                {result.chapters.length > 0 ? (
                  <div className="preview-list" data-testid="list-chapters">
                    {result.chapters.map((chapter, index) => (
                      <div className="chapter-row" key={`${chapter.number}-${index}`} style={{ animationDelay: `${Math.min(index, 12) * 25}ms` }} data-testid={`row-chapter-${index + 1}`}>
                        <span className="chapter-index">#{String(chapter.number).padStart(2, '0')}</span>
                        <span className="chapter-title" title={chapter.title}>{chapter.title}</span>
                        <span className="chapter-meta">{formatCount(chapter.characters)} chars</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="py-14 text-center" data-testid="empty-chapters">
                    <div className="empty-orb"><ListTree size={27} strokeWidth={1.5} /></div>
                    <h3 className="mt-5 text-base font-semibold">No sections to show yet</h3>
                    <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
                      Try a different detection method, or lower the fixed-line setting to create a useful preview.
                    </p>
                  </div>
                )}
              </section>
            </div>

            <section className="panel export-panel fade-up delay-3 mt-5 p-5 sm:p-6">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <div className="eyebrow mb-1">Book details</div>
                  <h2 className="text-xl font-semibold tracking-tight">Ready to make your EPUB?</h2>
                  <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
                    These details become the book metadata. Your current {formatCount(result.chapters.length)}-chapter split will be used as-is.
                  </p>
                </div>
                <BookOpen size={20} className="hidden text-primary sm:block" />
              </div>

              <div className="mt-6 grid gap-4 sm:grid-cols-3">
                <div>
                  <label className="setting-label" htmlFor="book-title">Book title</label>
                  <input
                    id="book-title"
                    className="setting-control"
                    value={bookTitle}
                    onChange={(event) => {
                      setBookTitle(event.target.value);
                      setEpubBlob(null);
                    }}
                    placeholder="My Novel"
                    data-testid="input-book-title"
                  />
                </div>
                <div>
                  <label className="setting-label" htmlFor="book-author">Author</label>
                  <input
                    id="book-author"
                    className="setting-control"
                    value={author}
                    onChange={(event) => {
                      setAuthor(event.target.value);
                      setEpubBlob(null);
                    }}
                    placeholder="Author name"
                    data-testid="input-book-author"
                  />
                </div>
                <div>
                  <label className="setting-label" htmlFor="book-language">Language</label>
                  <select
                    id="book-language"
                    className="setting-control"
                    value={language}
                    onChange={(event) => {
                      setLanguage(event.target.value);
                      setEpubBlob(null);
                    }}
                    data-testid="select-book-language"
                  >
                    <option value="zh-CN">Chinese (Simplified)</option>
                    <option value="zh-TW">Chinese (Traditional)</option>
                    <option value="en">English</option>
                    <option value="ja">Japanese</option>
                    <option value="ko">Korean</option>
                    <option value="other">Other</option>
                  </select>
                </div>
              </div>

              <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
                <div className="min-w-0">
                  <label className="setting-label" htmlFor="cover-image">Cover image <span className="font-normal text-muted-foreground">(optional)</span></label>
                  <div className="flex flex-wrap items-center gap-3">
                    <input
                      ref={coverInputRef}
                      id="cover-image"
                      className="sr-only"
                      type="file"
                      accept="image/png,image/jpeg,image/gif,image/webp"
                      onChange={(event) => {
                        const selected = event.target.files?.[0];
                        if (selected) {
                          setCoverFile(selected);
                          setEpubBlob(null);
                        }
                      }}
                      data-testid="input-cover-image"
                    />
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => coverInputRef.current?.click()}
                      data-testid="button-choose-cover"
                    >
                      <ImagePlus size={16} />
                      {coverFile ? 'Change cover' : 'Choose cover'}
                    </button>
                    {coverFile && (
                      <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                        <span className="max-w-[220px] truncate">{coverFile.name}</span>
                        <button
                          type="button"
                          className="btn-quiet min-h-8 px-1.5"
                          onClick={() => {
                            setCoverFile(undefined);
                            setEpubBlob(null);
                            if (coverInputRef.current) coverInputRef.current.value = '';
                          }}
                          aria-label="Remove cover image"
                          data-testid="button-remove-cover"
                        >
                          <X size={15} />
                        </button>
                      </span>
                    )}
                  </div>
                  <span className="setting-hint">PNG, JPEG, GIF, or WebP. Added to the EPUB when provided.</span>
                </div>

                <button
                  type="button"
                  className="btn-primary sm:min-w-48"
                  onClick={convertToEpub}
                  disabled={isConverting || result.chapters.length === 0}
                  data-testid="button-convert-epub"
                >
                  {isConverting ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" /> : <BookOpen size={16} />}
                  {isConverting ? 'Creating EPUB…' : 'Convert to EPUB'}
                </button>
              </div>

              {exportError && (
                <div className="notice mt-4" role="alert" data-testid="status-export-error">
                  <AlertCircle size={15} />
                  <span>{exportError}</span>
                </div>
              )}

              {epubBlob && (
                <div className="export-success mt-5" role="status" data-testid="status-epub-success">
                  <div className="flex items-center gap-2 text-sm font-semibold text-primary">
                    <CheckCircle2 size={17} />
                    EPUB created successfully
                  </div>
                  <button
                    type="button"
                    className="btn-primary mt-3 w-full sm:w-auto"
                    onClick={downloadEpub}
                    data-testid="button-download-epub"
                  >
                    <Download size={16} />
                    Download EPUB
                  </button>
                </div>
              )}
            </section>
          </section>
        )}

        <footer className="flex flex-col gap-2 border-t border-border/70 py-7 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <span>Made for long-form reading files.</span>
          <span className="mono">LOCAL PARSING · NO SERVER UPLOAD</span>
        </footer>
      </div>
    </main>
  );
}

export default App;