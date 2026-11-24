import { getItemIcon } from "../utils/itemIcons.js";

export default function ItemCard({ item, index, onClaimItem }) {
  const photoUrl = Array.isArray(item.publicImages) && item.publicImages.length > 0 ? item.publicImages[0] : null;
  const isClaimable = item.reportType === "found" && item.status !== "returned";

  return (
    <article
      className="item-card"
      style={{ "--card-index": index, cursor: isClaimable && onClaimItem ? "pointer" : "default" }}
      onClick={() => {
        if (isClaimable && onClaimItem) onClaimItem(item);
      }}
    >
      <div
        className={`item-visual visual-${index % 5}`}
        style={photoUrl ? { backgroundImage: `url(${photoUrl})`, backgroundSize: "cover", backgroundPosition: "center", position: "relative" } : {}}
      >
        {photoUrl ? (
          <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.18)", borderRadius: "inherit" }} />
        ) : (
          <>
            <span className="visual-decoration decoration-one">✳</span>
            <span className="item-symbol">{getItemIcon(item)}</span>
          </>
        )}
        <span className={`status-pill ${item.reportType}`} style={{ position: "relative", zIndex: 2 }}>
          <span /> {item.reportType === "lost" ? "LOST ITEM" : "FOUND ITEM"}
        </span>
        <span className="visual-number" style={{ position: "relative", zIndex: 2 }}>{String(index + 1).padStart(2, "0")}</span>
      </div>

      <div className="item-info">
        <div className="item-category-row">
          <span className="item-category">{item.category}</span>
          <span className="item-date">
            {item.dateReported
              ? new Date(item.dateReported).toLocaleDateString("en-IN", {
                  day: "numeric",
                  month: "short",
                })
              : ""}
          </span>
        </div>
        <h3>{item.itemName}</h3>
        <div className="item-detail"><span>◉</span> {item.color}</div>
        <div className="item-detail"><span>⌖</span> {item.location}</div>

        <div className="item-card-footer">
          <span className="item-status-text">
            {item.status === "returned" ? "✓ Returned" : item.reportType === "lost" ? "Still looking" : "Waiting for owner"}
          </span>
          {isClaimable ? (
            <span className="item-card-arrow" title="Claim ownership" style={{ fontWeight: "700", color: "#274029" }}>
              Claim ↗
            </span>
          ) : (
            <span className="item-card-arrow">↗</span>
          )}
        </div>
      </div>
    </article>
  );
}
