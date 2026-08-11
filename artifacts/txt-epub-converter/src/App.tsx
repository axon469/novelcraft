import { useCallback, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  BookOpen,
  CheckCircle2,
  FileText,
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
    const content = lines.slice(heading.lineIndex, end).join('\n').trim();
    return {
      number: heading.number,
      title: heading.title,
      characters: content.length,
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

function App() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [isReading, setIsReading] = useState(false);
  const [fileError, setFileError] = useState('');
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
    if (inputRef.current) inputRef.current.value = '';
  };

  const updateSetting = <K extends keyof DetectionSettings>(key: K, value: DetectionSettings[K]) => {
    setSettings((current) => ({ ...current, [key]: value }));
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
                  onClick={() => setDetectionVersion((current) => current + 1)}
                  data-testid="button-redetect"
                >
                  <RefreshCw size={16} />
                  Re-detect chapters
                </button>
                <div className="notice mt-4">
                  <Info size={15} />
                  <span>Your text never leaves this browser. EPUB generation comes next.</span>
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