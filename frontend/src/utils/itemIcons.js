export function getItemIcon(item) {
  const categoryName = String(item.category || "").toLowerCase();
  const name = String(item.itemName || "").toLowerCase();

  if (categoryName.includes("electronic")) return "⌁";
  if (categoryName.includes("document")) return "▤";
  if (categoryName.includes("bottle") || name.includes("bottle")) return "♧";
  if (categoryName.includes("accessor")) return "✳";
  if (name.includes("wallet")) return "▰";
  if (name.includes("key")) return "⚿";

  return "✦";
}
