import fs from "fs";
import puppeteer from "puppeteer";

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

function resolveChromeExecutable() {
  const envPath = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH;
  if (envPath && fs.existsSync(envPath)) {
    return envPath;
  }

  try {
    const bundled = puppeteer.executablePath();
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

export async function renderHtmlToPdfBuffer(html, options = {}) {
  const executablePath = resolveChromeExecutable();
  const browser = await puppeteer.launch({
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    headless: "new",
    timeout: 120000,
    ...(executablePath ? { executablePath } : {})
  });

  try {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(30000);
    page.setDefaultTimeout(30000);
    const wrappedHtml = `
      <!doctype html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { margin: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        </style>
      </head>
      <body>${html || ""}</body>
      </html>
    `;

    await page.setContent(wrappedHtml, { waitUntil: "networkidle0", timeout: 30000 });
    const pdfBuffer = await page.pdf({ ...defaultPdfOptions, ...options });
    await page.close();
    return pdfBuffer;
  } finally {
    await browser.close();
  }
}
