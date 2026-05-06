import { getOSPlatform } from '@/utils/misc';
import '@pdfjs/pdf.min.mjs';

type PDFJS = {
  GlobalWorkerOptions: { workerSrc: string };
  PDFDataRangeTransport: new (length: number, initialData: Uint8Array[]) => {
    requestDataRange?: (begin: number, end: number) => void;
    onDataRange: (begin: number, chunk: ArrayBuffer) => void;
  };
  TextLayer: new (args: {
    textContentSource: unknown;
    container: Element;
    viewport: unknown;
  }) => { render: () => Promise<void> };
  AnnotationLayer: new (args: {
    page: unknown;
    viewport: unknown;
    div: Element;
    linkService: {
      goToDestination: () => void;
      getDestinationHash: (dest: unknown) => string;
      addLinkAttributes: (link: HTMLAnchorElement, url: string) => void;
    };
  }) => { render: (args: { annotations: unknown }) => Promise<void> };
  getDocument: (args: Record<string, unknown>) => { promise: Promise<any> };
};

const PDF_ASSET_BASE = '/vendor/pdfjs';
const LARGE_PDF_SIZE = 50 * 1024 * 1024;
const ANDROID_RANGE_CHUNK_SIZE = 64 * 1024;

const pipeRangeInChunks = async (
  file: File,
  begin: number,
  end: number,
  chunkSize: number,
  onChunk: (offset: number, chunk: ArrayBuffer) => void,
) => {
  for (let offset = begin; offset < end; offset += chunkSize) {
    const chunkEnd = Math.min(end, offset + chunkSize);
    const chunk = await file.slice(offset, chunkEnd).arrayBuffer();
    onChunk(offset, chunk);
  }
};

const pdfjsPath = (path: string) => `${PDF_ASSET_BASE}/${path}`;

const pdfjsLib = (globalThis as Record<string, unknown>)['pdfjsLib'] as PDFJS;
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsPath('pdf.worker.min.mjs');

let cssPromise: Promise<{ text: string; annotation: string }> | null = null;

const fetchText = async (url: string): Promise<string> => {
  try {
    return await (await fetch(url)).text();
  } catch {
    return '';
  }
};

const getLayerCSS = async () => {
  if (!cssPromise) {
    cssPromise = Promise.all([
      fetchText(pdfjsPath('text_layer_builder.css')),
      fetchText(pdfjsPath('annotation_layer_builder.css')),
    ]).then(([text, annotation]) => ({ text, annotation }));
  }
  return cssPromise;
};

const render = async (
  page: any,
  doc: Document,
  zoom: number,
  enableTextLayer: boolean,
) => {
  const dpr = globalThis.devicePixelRatio || 1;
  const scale = zoom * dpr;
  doc.documentElement.style.transform = `scale(${1 / dpr})`;
  doc.documentElement.style.transformOrigin = 'top left';
  doc.documentElement.style.setProperty('--scale-factor', String(scale));
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement('canvas');
  canvas.height = viewport.height;
  canvas.width = viewport.width;
  const canvasContext = canvas.getContext('2d');
  await page.render({ canvasContext, viewport }).promise;
  doc.querySelector('#canvas')?.replaceChildren(doc.adoptNode(canvas));

  if (enableTextLayer) {
    const container = doc.querySelector('.textLayer');
    if (container) {
      const textLayer = new pdfjsLib.TextLayer({
        textContentSource: await page.streamTextContent(),
        container,
        viewport,
      });
      await textLayer.render();

      for (const hiddenCanvas of document.querySelectorAll('.hiddenCanvasElement')) {
        Object.assign((hiddenCanvas as HTMLElement).style, {
          position: 'absolute',
          top: '0',
          left: '0',
          width: '0',
          height: '0',
          display: 'none',
        });
      }

      const endOfContent = document.createElement('div');
      endOfContent.className = 'endOfContent';
      container.append(endOfContent);
      (container as HTMLElement).onpointerdown = () => container.classList.add('selecting');
      (container as HTMLElement).onpointerup = () => container.classList.remove('selecting');
    }
  }

  const div = doc.querySelector('.annotationLayer');
  if (div) {
    const linkService = {
      goToDestination: () => {},
      getDestinationHash: (dest: unknown) => JSON.stringify(dest),
      addLinkAttributes: (link: HTMLAnchorElement, url: string) => {
        link.href = url;
      },
    };
    await new pdfjsLib.AnnotationLayer({ page, viewport, div, linkService }).render({
      annotations: await page.getAnnotations(),
    });
  }
};

const renderPage = async (page: any, getImageBlob?: boolean, enableTextLayer = true) => {
  const viewport = page.getViewport({ scale: 1 });
  if (getImageBlob) {
    const canvas = document.createElement('canvas');
    canvas.height = viewport.height;
    canvas.width = viewport.width;
    const canvasContext = canvas.getContext('2d');
    await page.render({ canvasContext, viewport }).promise;
    return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve));
  }

  const { text, annotation } = await getLayerCSS();
  const textLayerHtml = enableTextLayer ? '<div class="textLayer"></div>' : '';
  const textLayerCSS = enableTextLayer ? text : '';

  const src = URL.createObjectURL(
    new Blob(
      [
        `<!DOCTYPE html>
        <html lang="en">
        <meta charset="utf-8">
        <meta name="viewport" content="width=${viewport.width}, height=${viewport.height}">
        <style>
        html, body { margin: 0; padding: 0; }
        :root {
          --user-unit: 1;
          --total-scale-factor: calc(var(--scale-factor) * var(--user-unit));
          --scale-round-x: 1px;
          --scale-round-y: 1px;
        }
        ${textLayerCSS}
        ${annotation}
        </style>
        <div id="canvas"></div>
        ${textLayerHtml}
        <div class="annotationLayer"></div>`,
      ],
      { type: 'text/html' },
    ),
  );

  const onZoom = ({ doc, scale }: { doc: Document; scale: number }) =>
    render(page, doc, scale, enableTextLayer);
  return { src, onZoom };
};

const makeTOCItem = (item: any): any => ({
  label: item.title,
  href: JSON.stringify(item.dest),
  subitems: item.items.length ? item.items.map(makeTOCItem) : null,
});

export const makePDF = async (file: File) => {
  const isAndroid = getOSPlatform() === 'android';
  const enableTextLayer = !(isAndroid && file.size >= LARGE_PDF_SIZE);

  const transport = new pdfjsLib.PDFDataRangeTransport(file.size, []);
  transport.requestDataRange = (begin, end) => {
    if (isAndroid) {
      pipeRangeInChunks(file, begin, end, ANDROID_RANGE_CHUNK_SIZE, (offset, chunk) => {
        transport.onDataRange(offset, chunk);
      });
      return;
    }
    file.slice(begin, end).arrayBuffer().then((chunk) => {
      transport.onDataRange(begin, chunk);
    });
  };

  const pdf = await pdfjsLib
    .getDocument({
      range: transport,
      rangeChunkSize: isAndroid ? ANDROID_RANGE_CHUNK_SIZE : undefined,
      disableAutoFetch: isAndroid,
      disableStream: isAndroid,
      cMapUrl: pdfjsPath('cmaps/'),
      standardFontDataUrl: pdfjsPath('standard_fonts/'),
      isEvalSupported: false,
    })
    .promise;

  const book: Record<string, any> = { rendition: { layout: 'pre-paginated' } };

  const metadataInfo = (await pdf.getMetadata()) ?? {};
  const metadata = metadataInfo.metadata;
  const info = metadataInfo.info;
  book.metadata = {
    title: metadata?.get('dc:title') ?? info?.Title,
    author: metadata?.get('dc:creator') ?? info?.Author,
    contributor: metadata?.get('dc:contributor'),
    description: metadata?.get('dc:description') ?? info?.Subject,
    language: metadata?.get('dc:language'),
    publisher: metadata?.get('dc:publisher'),
    subject: metadata?.get('dc:subject'),
    identifier: metadata?.get('dc:identifier'),
    source: metadata?.get('dc:source'),
    rights: metadata?.get('dc:rights'),
  };

  const outline = await pdf.getOutline();
  book.toc = outline?.map(makeTOCItem);

  const cache = new Map<number, unknown>();
  book.sections = Array.from({ length: pdf.numPages }).map((_, i) => ({
    id: i,
    load: async () => {
      const cached = cache.get(i);
      if (cached) return cached;
      const url = await renderPage(await pdf.getPage(i + 1), false, enableTextLayer);
      cache.set(i, url);
      return url;
    },
    size: 1000,
  }));
  book.isExternal = (uri: string) => /^\w+:/i.test(uri);
  book.resolveHref = async (href: string) => {
    const parsed = JSON.parse(href);
    const dest = typeof parsed === 'string' ? await pdf.getDestination(parsed) : parsed;
    const index = await pdf.getPageIndex(dest[0]);
    return { index };
  };
  book.splitTOCHref = async (href: string) => {
    const parsed = JSON.parse(href);
    const dest = typeof parsed === 'string' ? await pdf.getDestination(parsed) : parsed;
    const index = await pdf.getPageIndex(dest[0]);
    return [index, null];
  };
  book.getTOCFragment = (doc: Document) => doc.documentElement;
  book.getCover = async () => renderPage(await pdf.getPage(1), true, enableTextLayer);
  book.destroy = () => pdf.destroy();
  return book;
};
