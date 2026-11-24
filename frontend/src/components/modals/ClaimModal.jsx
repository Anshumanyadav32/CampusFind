import { useState, useEffect } from "react";
import axios from "axios";

export default function ClaimModal({
  item,
  showClaimModal,
  onClose,
  currentUser,
  API_BASE_URL,
  onClaimSubmitted
}) {
  const [loadingQuestions, setLoadingQuestions] = useState(() => Boolean(showClaimModal && item));
  const [questions, setQuestions] = useState([]);
  const [answers, setAnswers] = useState({});
  const [additionalDetails, setAdditionalDetails] = useState("");
  const [proofFiles, setProofFiles] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let ignore = false;
    if (showClaimModal && item) {
      axios
        .get(`${API_BASE_URL}/claims/item/${item._id}`)
        .then((res) => {
          if (!ignore) {
            setQuestions(res.data.verificationQuestions || []);
            setLoadingQuestions(false);
          }
        })
        .catch(() => {
          if (!ignore) {
            setQuestions([]);
            setLoadingQuestions(false);
          }
        });
    }
    return () => {
      ignore = true;
    };
  }, [showClaimModal, item, API_BASE_URL]);

  if (!showClaimModal || !item) return null;

  function getDisplayUrl(url) {
    if (!url) return "";
    if (
      url.startsWith("http://") ||
      url.startsWith("https://") ||
      url.startsWith("blob:") ||
      url.startsWith("data:")
    ) {
      return url;
    }
    const backendBase = (API_BASE_URL || "http://localhost:5000/api").replace(/\/api\/?$/, "");
    return `${backendBase}${url.startsWith("/") ? "" : "/"}${url}`;
  }

  function getProofUrl(filename) {
    if (filename.startsWith("http://") || filename.startsWith("https://")) {
      return filename;
    }
    return `${API_BASE_URL}/claims/proof/${encodeURIComponent(filename)}`;
  }

  async function handleProofUpload(event) {
    const files = Array.from(event.target.files || []);
    if (files.length === 0) return;

    for (const file of files) {
      if (file.size > 5 * 1024 * 1024) {
        setError(`File "${file.name}" exceeds the 5MB size limit.`);
        return;
      }
      if (!file.type.startsWith("image/") && file.type !== "application/pdf") {
        setError(`File "${file.name}" must be an image (JPEG/PNG/WebP) or PDF.`);
        return;
      }
    }

    setError("");
    setUploading(true);

    const formData = new FormData();
    files.forEach((file) => formData.append("images", file));

    try {
      const uploadEndpoint = `${API_BASE_URL}/claims/proof/upload`;
      const res = await axios.post(uploadEndpoint, formData, { withCredentials: true });
      const filenames = Array.isArray(res.data.files)
        ? res.data.files.map((file) => file.filename)
        : [];
      if (filenames.length !== files.length || filenames.some((filename) => typeof filename !== "string")) {
        throw new Error("The server returned an invalid evidence upload response.");
      }
      setProofFiles((prev) => [...prev, ...filenames]);
    } catch (err) {
      setError(err.response?.data?.message || "Failed to upload evidence file.");
    } finally {
      setUploading(false);
      event.target.value = "";
    }
  }

  function removeProof(idx) {
    setProofFiles((prev) => prev.filter((_, i) => i !== idx));
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (!currentUser) {
      setError("Please sign in before submitting an ownership claim.");
      return;
    }

    setSubmitting(true);
    setError("");

    const formattedAnswers = questions.map((q, idx) => ({
      question: q,
      answer: answers[idx] || ""
    }));

    try {
      const payload = {
        itemId: item._id,
        verificationAnswers: formattedAnswers,
        additionalDetails,
        proofFiles
      };

      const res = await axios.post(`${API_BASE_URL}/claims`, payload);
      if (onClaimSubmitted) {
        onClaimSubmitted(res.data.message || "Claim submitted successfully!");
      }
      onClose();
    } catch (err) {
      setError(err.response?.data?.message || "Could not submit claim. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  const primaryPhoto = Array.isArray(item.publicImages) && item.publicImages.length > 0 ? item.publicImages[0] : null;

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !submitting && !uploading) {
          onClose();
        }
      }}
    >
      <section className="report-modal" style={{ maxWidth: "620px", maxHeight: "90vh", overflowY: "auto" }}>
        <div className="modal-header">
          <div>
            <div className="section-kicker"><span /> OWNERSHIP VERIFICATION</div>
            <h2>Claim this item<span>.</span></h2>
            <p>Answer the reporter&apos;s verification questions and attach ownership proof.</p>
          </div>
          <button className="modal-close" onClick={onClose} disabled={submitting || uploading}>
            ×
          </button>
        </div>

        {error && (
          <div className="notice error" role="status" style={{ margin: "14px 0" }}>
            <span>⚠</span> {error}
          </div>
        )}

        {/* Item Summary Card */}
        <div
          style={{
            background: "#fbfbf7",
            padding: "16px",
            borderRadius: "10px",
            border: "1px solid #e8e7dd",
            margin: "16px 0",
            display: "flex",
            gap: "14px",
            alignItems: "center"
          }}
        >
          {primaryPhoto && (
            <img
              src={getDisplayUrl(primaryPhoto)}
              alt={item.itemName}
              style={{ width: "70px", height: "70px", objectFit: "cover", borderRadius: "8px" }}
            />
          )}
          <div>
            <span className="match-label" style={{ color: "#274029" }}>FOUND REPORT</span>
            <h3 style={{ margin: "2px 0 4px 0", fontSize: "18px" }}>{item.itemName}</h3>
            <small style={{ color: "#777" }}>
              {item.category} · {item.color} · Found at {item.location}
            </small>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="report-form">
          {loadingQuestions ? (
            <div className="state-panel" style={{ padding: "20px" }}>
              <div className="loader" />
              <p>Loading verification questions...</p>
            </div>
          ) : (
            <>
              {questions.length > 0 ? (
                <div style={{ marginBottom: "16px" }}>
                  <label style={{ fontWeight: "700", color: "#274029", marginBottom: "8px", display: "block" }}>
                    Hidden Verification Questions:
                  </label>
                  {questions.map((q, idx) => (
                    <div key={idx} style={{ marginBottom: "12px" }}>
                      <span style={{ fontSize: "13px", fontWeight: "600", display: "block", marginBottom: "4px" }}>
                        Q{idx + 1}: {q}
                      </span>
                      <input
                        required
                        value={answers[idx] || ""}
                        onChange={(e) => {
                          const val = e.target.value;
                          setAnswers((prev) => ({ ...prev, [idx]: val }));
                        }}
                        placeholder="Provide your secret answer..."
                        style={{ width: "100%" }}
                      />
                    </div>
                  ))}
                </div>
              ) : (
                <p style={{ fontSize: "13px", color: "#666", marginBottom: "14px" }}>
                  The reporter did not configure specific questions. Please provide identifying details below.
                </p>
              )}

              <label>
                Additional Ownership Details
                <textarea
                  required
                  rows={3}
                  value={additionalDetails}
                  onChange={(e) => setAdditionalDetails(e.target.value)}
                  placeholder="Describe unique marks, serial numbers, date and location of loss, or exact contents inside..."
                  style={{ width: "100%", padding: "10px", borderRadius: "8px", border: "1px solid #ccc", fontFamily: "inherit" }}
                />
              </label>

              {/* Private Proof / Document Upload */}
              <div style={{ margin: "16px 0" }}>
                <label style={{ fontWeight: "600", display: "block", marginBottom: "6px" }}>
                  Supporting Evidence (Receipt, Serial Number, or Earlier Photo):
                </label>
                <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                  <input
                    type="file"
                    accept="image/*,application/pdf"
                    multiple
                    onChange={handleProofUpload}
                    disabled={uploading || submitting}
                    id="proof-upload-input"
                    style={{ display: "none" }}
                  />
                  <label
                    htmlFor="proof-upload-input"
                    className="button button-outline"
                    style={{ margin: 0, padding: "8px 14px", fontSize: "13px", cursor: "pointer" }}
                  >
                    {uploading ? "Uploading..." : "Upload Evidence Proof +"}
                  </label>
                  <small style={{ color: "#777" }}>Max 5MB (JPEG, PNG, WebP, PDF). Protected from public.</small>
                </div>

                {proofFiles.length > 0 && (
                  <div style={{ display: "flex", gap: "10px", marginTop: "12px", flexWrap: "wrap" }}>
                    {proofFiles.map((url, idx) => (
                      <div
                        key={idx}
                        style={{
                          position: "relative",
                          width: "75px",
                          height: "75px",
                          border: "1px solid #ddd",
                          borderRadius: "8px",
                          overflow: "hidden"
                        }}
                      >
                        {url.toLowerCase().endsWith(".pdf") || url.toLowerCase().includes(".pdf") ? (
                          <div style={{ display: "grid", placeItems: "center", height: "100%", background: "#fee", fontSize: "12px", fontWeight: "bold", color: "#b12d2d" }}>
                            📄 PDF
                          </div>
                        ) : (
                          <img
                            src={getProofUrl(url)}
                            crossOrigin="use-credentials"
                            alt="Proof"
                            style={{ width: "100%", height: "100%", objectFit: "cover" }}
                          />
                        )}
                        <button
                          type="button"
                          onClick={() => removeProof(idx)}
                          style={{
                            position: "absolute",
                            top: "2px",
                            right: "2px",
                            background: "rgba(0,0,0,0.65)",
                            color: "#fff",
                            border: "none",
                            borderRadius: "50%",
                            width: "20px",
                            height: "20px",
                            display: "grid",
                            placeItems: "center",
                            fontSize: "12px"
                          }}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div style={{ display: "flex", gap: "12px", marginTop: "20px" }}>
                <button
                  type="submit"
                  className="button button-dark"
                  disabled={submitting || uploading}
                  style={{ flex: 1, background: "#274029" }}
                >
                  {submitting ? "Submitting Claim..." : "Submit Ownership Claim ↗"}
                </button>
                <button
                  type="button"
                  className="button button-outline"
                  onClick={onClose}
                  disabled={submitting || uploading}
                >
                  Cancel
                </button>
              </div>
            </>
          )}
        </form>
      </section>
    </div>
  );
}
