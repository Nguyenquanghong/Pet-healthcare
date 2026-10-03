export function printRescueTag(popup: Window, input: { name: string; breed?: string; phone: string; qrImageUrl: string }) {
  const doc = popup.document;
  doc.title = `In thẻ cứu hộ - ${input.name}`;
  doc.documentElement.lang = "vi";
  const style = doc.createElement("style");
  style.textContent = `body { font-family: sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
    .tag { width: 260px; border: 3px solid #003f70; border-radius: 24px; padding: 20px; text-align: center; }
    .tag-pet { font-size: 22px; font-weight: 900; margin: 6px 0; } .tag-breed { color: #666; }
    .tag img { width: 180px; height: 180px; margin: 12px auto; display: block; }
    .tag-footer { font-size: 11px; color: #e11d48; font-weight: bold; } .tag-phone { color: #003f70; margin-top: 4px; }`;
  doc.head.append(style);
  const tag = doc.createElement("div");
  tag.className = "tag";
  const text = (className: string, value: string) => {
    const node = doc.createElement("div");
    node.className = className;
    node.textContent = value;
    tag.append(node);
  };
  text("tag-header", "NIPOPETO");
  text("tag-pet", input.name);
  text("tag-breed", input.breed ?? "");
  const image = doc.createElement("img");
  image.alt = "QR Code";
  image.onload = () => popup.print();
  image.onerror = () => popup.print();
  image.src = input.qrImageUrl;
  tag.append(image);
  text("tag-footer", "QUÉT MÃ ĐỂ BÁO TÌM THẤY");
  text("tag-phone", `Hotline: ${input.phone}`);
  doc.body.replaceChildren(tag);
  popup.onafterprint = () => popup.close();
}
