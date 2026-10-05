const Jimp = require("jimp");

const generateProfilePicture = async (imageBuffer) => {
  try {
    const jimpImage = await Jimp.read(imageBuffer);
    const width = jimpImage.getWidth();
    const height = jimpImage.getHeight();

    // Preserve original aspect ratio without any automatic cropping
    let processed = jimpImage.clone();

    // Maximize resolution: WhatsApp profile picture server accepts up to 1080px
    // If the image is larger than 1080px, scale down smoothly to 1080px
    // If the image is 1080px or smaller, keep its 100% native resolution
    const maxDimension = Math.max(width, height);
    if (maxDimension > 1080) {
      processed = processed.scaleToFit(1080, 1080);
    }

    // Set maximum JPEG quality (100) to prevent compression artifacts
    const imgBuf = await processed.quality(100).getBufferAsync(Jimp.MIME_JPEG);
    const previewBuf = await processed.clone().scaleToFit(720, 720).quality(95).getBufferAsync(Jimp.MIME_JPEG);

    return {
      img: imgBuf,
      preview: previewBuf
    };
  } catch (error) {
    console.error("Failed to generate profile picture ", error);
    throw error;
  }
};

module.exports = generateProfilePicture;
