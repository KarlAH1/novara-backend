import fs from "fs";
import puppeteer from "puppeteer";

const maxConcurrentPages = Math.max(1, Number(process.env.PDF_CONCURRENCY || 2));
const maxHtmlBytes = Math.max(1024, Number(process.env.PDF_MAX_HTML_BYTES || 2_000_000));
let browserPromise = null;
let activePages = 0;
const pageWaiters = [];

const defaultPdfOptions = {
  format: "A4",
  printBackground: true,
  margin: {
    top: "24px",
    right: "24px",
    bottom: "24px",
    left: "24px"
  }
};

async function resolveChromeExecutable() {
  const envPath = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH;
  if (envPath && fs.existsSync(envPath)) {
    return envPath;
  }

  try {
    const bundled = await puppeteer.executablePath();
    if (bundled && fs.existsSync(bundled)) {
      return bundled;
    }
  } catch (err) {
    // ignore
  }

  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser"
  ];

  return candidates.find((item) => fs.existsSync(item));
}

async function acquirePageSlot() {
  if (activePages < maxConcurrentPages) {
    activePages += 1;
    return;
  }

  await new Promise((resolve) => pageWaiters.push(resolve));
  activePages += 1;
}

function releasePageSlot() {
  activePages = Math.max(0, activePages - 1);
  pageWaiters.shift()?.();
}

async function getBrowser() {
  if (browserPromise) return browserPromise;

  const executablePath = await resolveChromeExecutable();
  browserPromise = puppeteer.launch({
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    headless: "new",
    timeout: 120000,
    ...(executablePath ? { executablePath } : {})
  });

  try {
    const browser = await browserPromise;
    browser.once("disconnected", () => {
      browserPromise = null;
    });
    return browser;
  } catch (error) {
    browserPromise = null;
    throw error;
  }
}

export async function closePdfBrowser() {
  const pendingBrowser = browserPromise;
  browserPromise = null;
  if (!pendingBrowser) return;

  const browser = await pendingBrowser.catch(() => null);
  if (browser?.connected) await browser.close();
}

export async function renderHtmlToPdfBuffer(html, options = {}) {
  const htmlContent = String(html || "");
  if (Buffer.byteLength(htmlContent, "utf8") > maxHtmlBytes) {
    throw Object.assign(new Error("Document HTML is too large to render"), { status: 413 });
  }

  await acquirePageSlot();
  let page;

  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    page.setDefaultNavigationTimeout(30000);
    page.setDefaultTimeout(30000);
    await page.setJavaScriptEnabled(false);
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      const protocol = (() => {
        try {
          return new URL(request.url()).protocol;
        } catch {
          return "";
        }
      })();

      if (["http:", "https:", "file:", "ftp:"].includes(protocol)) {
        request.abort();
      } else {
        request.continue();
      }
    });

    const wrappedHtml = `
      <!doctype html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { margin: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        </style>
      </head>
      <body>${htmlContent}</body>
      </html>
    `;

    await page.setContent(wrappedHtml, { waitUntil: "domcontentloaded", timeout: 30000 });
    // Puppeteer 25 returns Uint8Array; keep the existing Buffer contract used
    // by Express responses and ZIP generation.
    return Buffer.from(await page.pdf({ ...defaultPdfOptions, ...options }));
  } finally {
    await page?.close().catch(() => {});
    releasePageSlot();
  }
}
