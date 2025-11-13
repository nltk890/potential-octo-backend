export function sanitizeInput(text) {
  return text
    .replace(/<.*?>/g, "")
    .replace(/[{}[\]();]/g, "")
    .replace(/[^ \w\s.,!'-]/g, " ")
    .trim();
}