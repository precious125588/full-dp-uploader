const Jimp = require("jimp");

const generateProfilePicture = async (imageBuffer) => {
  try {
    const jimpImage = await Jimp.read(imageBuffer);
    const width = jimpImage.getWidth();
    const height = jimpImage.getHeight();
    const cropped = jimpImage.crop(0, 0, width, height);
    return {
      img: await cropped.scaleToFit(720, 720).getBufferAsync(Jimp.MIME_JPEG),
      preview: await cropped.normalize().getBufferAsync(Jimp.MIME_JPEG)
    };
  } catch (error) {
    console.error("Failed to generate profile picture ", error);
    throw error;
  }
};

module.exports = generateProfilePicture;
