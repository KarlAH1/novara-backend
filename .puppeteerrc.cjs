const path = require("path");

/*
  Render's build and runtime steps do not reliably share the default
  ~/.cache/puppeteer directory, so Chrome is installed inside the project where
  the running service can find it. Without this the PDF renderer cannot launch
  a browser in production and every document download fails.
*/
module.exports = {
  cacheDirectory: path.join(__dirname, ".cache", "puppeteer")
};
