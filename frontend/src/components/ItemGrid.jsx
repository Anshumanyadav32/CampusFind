import ItemCard from "./ItemCard.jsx";

export default function ItemGrid({
  loading,
  error,
  filteredItems,
  fetchItems,
  openReport,
  onClaimItem,
  activeTab,
  page,
  PAGE_SIZE,
  totalItems,
  totalPages,
  setPage,
  setLoading
}) {
  if (loading) {
    return (
      <div className="state-panel">
        <div className="loader" />
        <p>Finding your items...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="state-panel">
        <span className="state-emoji">⚠</span>
        <h3>We couldn't load the board.</h3>
        <p>{error}</p>
        <button className="button button-dark" onClick={fetchItems}>
          Try again ↻
        </button>
      </div>
    );
  }

  if (filteredItems.length === 0) {
    return (
      <div className="state-panel empty-panel">
        <span className="state-emoji">✳</span>
        <h3>No matches just yet.</h3>
        <p>Try another search or be the first to report an item.</p>
        <button
          className="button button-dark"
          onClick={() => openReport(activeTab === "found" ? "found" : "lost")}
        >
          Report an item ↗
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="items-grid">
        {filteredItems.map((item, index) => (
          <ItemCard key={item._id} item={item} index={index} onClaimItem={onClaimItem} />
        ))}
      </div>

      <div className="board-footer">
        <span>
          SHOWING {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, totalItems)} OF {totalItems} ITEMS
        </span>
        <span>Good things happen when we look out for each other ✳</span>
      </div>

      {totalPages > 1 && (
        <div className="pagination-controls" aria-label="Item report pages">
          <button
            className="button button-outline"
            disabled={page <= 1}
            onClick={() => {
              setLoading(true);
              setPage((current) => current - 1);
            }}
          >
            Previous
          </button>
          <span>
            Page {page} of {totalPages}
          </span>
          <button
            className="button button-outline"
            disabled={page >= totalPages}
            onClick={() => {
              setLoading(true);
              setPage((current) => current + 1);
            }}
          >
            Next
          </button>
        </div>
      )}
    </>
  );
}
