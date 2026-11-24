export default function FilterBar({
  activeTab,
  setActiveTab,
  search,
  setSearch,
  category,
  setCategory,
  setPage,
  setLoading
}) {
  return (
    <div className="filters-panel">
      <div className="filter-tabs">
        {[
          { value: "all", label: "Everything" },
          { value: "lost", label: "✕ Lost" },
          { value: "found", label: "✓ Found" },
        ].map((tab) => (
          <button
            key={tab.value}
            className={activeTab === tab.value ? "filter-tab selected" : "filter-tab"}
            onClick={() => {
              setLoading(true);
              setPage(1);
              setActiveTab(tab.value);
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="filter-controls">
        <label className="search-box">
          <span>⌕</span>
          <input
            type="search"
            placeholder="Search name, color, location..."
            value={search}
            onChange={(event) => {
              setLoading(true);
              setSearch(event.target.value);
            }}
          />
          {search && (
            <button
              onClick={() => {
                setLoading(true);
                setSearch("");
              }}
              aria-label="Clear search"
            >
              ×
            </button>
          )}
        </label>

        <select
          className="category-select"
          value={category}
          onChange={(event) => {
            setLoading(true);
            setPage(1);
            setCategory(event.target.value);
          }}
          aria-label="Filter by category"
        >
          <option value="all">All categories</option>
          <option value="Electronics">Electronics</option>
          <option value="Accessories">Accessories</option>
          <option value="Documents">Documents</option>
          <option value="Bottle">Bottle</option>
          <option value="Clothing">Clothing</option>
          <option value="Other">Other</option>
        </select>
      </div>
    </div>
  );
}
