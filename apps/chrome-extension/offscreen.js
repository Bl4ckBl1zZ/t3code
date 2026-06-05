function normalizeQuality(input = {}) {
  const maxWidth = Number.isFinite(input.maxWidth) && input.maxWidth > 0 ? input.maxWidth : 1920;
  const maxHeight =
    Number.isFinite(input.maxHeight) && input.maxHeight > 0 ? input.maxHeight : 1080;
  const fps = Number.isFinite(input.fps) && input.fps > 0 ? Math.min(input.fps, 30) : 15;
  const imageQuality =
    Number.isFinite(input.imageQuality) && input.imageQuality > 0 && input.imageQuality <= 1
      ? input.imageQuality
      : 0.72;
  return {
    maxWidth,
    maxHeight,
    fps,
    imageQuality,
  };
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => resolve(image), { once: true });
    image.addEventListener(
      "error",
      () => reject(new Error("Failed to load captured screenshot.")),
      { once: true },
    );
    image.src = dataUrl;
  });
}

function encodeCanvas(canvas, quality) {
  const webp = canvas.toDataURL("image/webp", quality.imageQuality);
  if (webp.startsWith("data:image/webp")) {
    return webp;
  }
  return canvas.toDataURL("image/jpeg", quality.imageQuality);
}

async function optimizeScreenshot(message) {
  const quality = normalizeQuality(message.quality);
  const image = await loadImage(message.dataUrl);
  const scale = Math.min(1, quality.maxWidth / image.width, quality.maxHeight / image.height);
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) {
    throw new Error("Failed to prepare screenshot encoder.");
  }
  context.drawImage(image, 0, 0, width, height);
  return {
    dataUrl: encodeCanvas(canvas, quality),
    width,
    height,
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== "string") {
    return false;
  }
  if (message.type === "t3code.browserAgent.screenshot.optimize") {
    void optimizeScreenshot(message)
      .then((payload) => sendResponse({ ok: true, payload }))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    return true;
  }
  return false;
});
