const sharp = require('sharp');

/**
 * Levanter genProPic image pipeline:
 * Resizes with { fit: 'inside' }, uses maximum quality (100)
 * and chromaSubsampling: '4:4:4' to prevent JPEG color degradation.
 */
const generateProfilePicture = async (imageBuffer, width = 720, height = 720, quality = 100) => {
  try {
    const buffer = await sharp(imageBuffer)
      .resize(width, height, { fit: 'inside' })
      .jpeg({
        quality: quality,
        chromaSubsampling: '4:4:4'
      })
      .toBuffer();
    return { img: buffer };
  } catch (error) {
    console.error('Failed to generate profile picture with sharp:', error);
    throw error;
  }
};

module.exports = generateProfilePicture;
