// Base64 plus update metadata must fit Vercel's 4.5 MB function request limit.
export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
export const imageIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp)$/i;
export const imageMarker = id => `![Attached image](/api/images/${id})`;

export function splitImages(body) {
  const images = [];
  const text = String(body).replace(/!\[Attached image\]\(\/api\/images\/([^\s)]+)\)/g, (marker, id) => {
    if (!imageIdPattern.test(id)) return marker;
    images.push(id);
    return '';
  }).trim();
  return { text, images: [...new Set(images)] };
}
