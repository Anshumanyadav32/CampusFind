import { useEffect, useRef, useState } from "react";
import axios from "axios";

export default function ReportModal({
  showForm,
  setShowForm,
  submitting,
  form,
  setForm,
  submitReport,
  updateForm,
  currentUser,
  API_BASE_URL
}) {
  const [uploadingPublic, setUploadingPublic] = useState(false);
  const [uploadingPrivate, setUploadingPrivate] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [privatePreviewUrls, setPrivatePreviewUrls] = useState({});
  const privatePreviewUrlsRef = useRef({});

  useEffect(() => () => {
    Object.values(privatePreviewUrlsRef.current).forEach((url) => URL.revokeObjectURL(url));
  }, []);

  if (!showForm) return null;

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

  async function handleFileUpload(event, isPrivate = false) {
    const files = Array.from(event.target.files || []);
    if (files.length === 0) return;

    // Validate size (max 5MB) and type
    if (files.length > 10) {
      setUploadError("A maximum of 10 images can be uploaded at once.");
      return;
    }

    const allowedImageTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
    for (const file of files) {
      if (file.size > 5 * 1024 * 1024) {
        setUploadError(`File "${file.name}" exceeds the 5MB size limit.`);
        return;
      }
      if (!allowedImageTypes.has(file.type)) {
        setUploadError(`File "${file.name}" must be JPEG, PNG, WebP, or GIF.`);
        return;
      }
    }

    setUploadError("");
    const formData = new FormData();
    files.forEach((file) => formData.append("images", file));

    if (isPrivate) setUploadingPrivate(true);
    else setUploadingPublic(true);

    try {
      const uploadEndpoint = `${(API_BASE_URL || "http://localhost:5000/api").replace(/\/$/, "")}/upload?isPrivate=${isPrivate}`;
      const response = await axios.post(uploadEndpoint, formData);

      const targetField = isPrivate ? "privateImages" : "publicImages";
      let uploadedIdentifiers;
      if (isPrivate) {
        const uploadedFiles = response.data.files;
        if (!Array.isArray(uploadedFiles) || uploadedFiles.length !== files.length) {
          throw new Error("The server returned an invalid private photo response.");
        }
        uploadedIdentifiers = uploadedFiles.map((file) => file.filename);
        const newPreviews = Object.fromEntries(
          uploadedIdentifiers.map((filename, index) => [filename, URL.createObjectURL(files[index])])
        );
        privatePreviewUrlsRef.current = { ...privatePreviewUrlsRef.current, ...newPreviews };
        setPrivatePreviewUrls((previous) => ({ ...previous, ...newPreviews }));
      } else {
        uploadedIdentifiers = response.data.urls || [];
      }

      setForm((prev) => ({
        ...prev,
        [targetField]: [...(prev[targetField] || []), ...uploadedIdentifiers]
      }));
    } catch (err) {
      const serverMsg = err.response?.data?.message;
      if (serverMsg) {
        setUploadError(serverMsg);
      } else if (!err.response) {
        setUploadError("Could not reach backend upload server. Please verify your backend is running at http://localhost:5000.");
      } else {
        setUploadError("Failed to upload image. Please check your image format and try again.");
      }
    } finally {
      if (isPrivate) setUploadingPrivate(false);
      else setUploadingPublic(false);
      event.target.value = "";
    }
  }

  function removeImage(index, isPrivate = false) {
    const targetField = isPrivate ? "privateImages" : "publicImages";
    if (isPrivate) {
      const filename = form.privateImages[index];
      const previewUrl = privatePreviewUrlsRef.current[filename];
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      const remainingPreviews = { ...privatePreviewUrlsRef.current };
      delete remainingPreviews[filename];
      privatePreviewUrlsRef.current = remainingPreviews;
      setPrivatePreviewUrls(remainingPreviews);
    }
    setForm((prev) => ({
      ...prev,
      [targetField]: (prev[targetField] || []).filter((_, idx) => idx !== index)
    }));
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !submitting) {
          setShowForm(false);
        }
      }}
    >
      <section className="report-modal" role="dialog" aria-modal="true" aria-labelledby="report-title">
        <div className="modal-header">
          <div>
            <div className="section-kicker"><span /> COMMUNITY REPORT</div>
            <h2 id="report-title">Let's bring it <span>home.</span></h2>
            <p>Tell us a little about the item.</p>
          </div>
          <button
            className="modal-close"
            onClick={() => setShowForm(false)}
            disabled={submitting}
            aria-label="Close form"
          >
            ×
          </button>
        </div>

        <div className="report-type-picker">
          <button
            type="button"
            className={form.reportType === "lost" ? "type-option chosen lost-choice" : "type-option"}
            onClick={() => setForm({ ...form, reportType: "lost" })}
          >
            <span>⌕</span>
            <strong>I've lost it</strong>
            <small>Help me find it</small>
          </button>
          <button
            type="button"
            className={form.reportType === "found" ? "type-option chosen found-choice" : "type-option"}
            onClick={() => setForm({ ...form, reportType: "found" })}
          >
            <span>✳</span>
            <strong>I've found it</strong>
            <small>Help it get home</small>
          </button>
        </div>

        <form onSubmit={submitReport} className="report-form">
          <label>
            Item name
            <input
              name="itemName"
              value={form.itemName}
              onChange={updateForm}
              placeholder="e.g. Blue water bottle"
              required
              maxLength={100}
            />
          </label>

          <div className="form-row">
            <label>
              Category
              <select name="category" value={form.category} onChange={updateForm} required>
                <option>Electronics</option>
                <option>Accessories</option>
                <option>Documents</option>
                <option>Bottle</option>
                <option>Clothing</option>
                <option>Other</option>
              </select>
            </label>
            <label>
              Color
              <input
                name="color"
                value={form.color}
                onChange={updateForm}
                placeholder="e.g. Blue"
                required
                maxLength={50}
              />
            </label>
          </div>

          <label>
            Where was it lost or found?
            <input
              name="location"
              value={form.location}
              onChange={updateForm}
              placeholder="e.g. Library, Block 32"
              required
              maxLength={150}
            />
          </label>

          <div className="form-row">
            <label>
              Private Brand (Not Public)
              <input name="brand" value={form.brand} onChange={updateForm} maxLength={100} />
            </label>
            <label>
              Private Model (Not Public)
              <input name="model" value={form.model} onChange={updateForm} maxLength={100} />
            </label>
          </div>
          <label>
            Private Serial Number (Not Public)
            <input name="serialNumber" value={form.serialNumber} onChange={updateForm} maxLength={100} />
          </label>
          <label>
            Unique Identifying Marks or Physical Damage (Not Public)
            <textarea
              name="identifyingMarks"
              value={form.identifyingMarks}
              onChange={updateForm}
              rows={2}
              maxLength={500}
            />
          </label>
          <label>
            Special Accessories (Not Public)
            <input name="accessories" value={form.accessories} onChange={updateForm} maxLength={500} />
          </label>
          <label>
            Physical Damage Details (Not Public)
            <input name="physicalDamage" value={form.physicalDamage} onChange={updateForm} maxLength={500} />
          </label>
          <label>
            Private Ownership Verification Question (Not Public)
            <input
              name="verificationQuestion"
              value={form.verificationQuestion}
              onChange={updateForm}
              placeholder="Ask something only the owner would know"
              maxLength={250}
            />
          </label>

          {/* Direct Photo Uploads (Public) */}
          <div style={{ marginTop: "10px" }}>
            <label style={{ display: "block", marginBottom: "6px" }}>
              Public Item Photos (Optional, max 5MB each)
              <input
                type="file"
                multiple
                accept="image/jpeg,image/png,image/webp,image/gif"
                onChange={(e) => handleFileUpload(e, false)}
                disabled={uploadingPublic}
                style={{ marginTop: "6px", display: "block" }}
              />
            </label>
            {uploadingPublic && <small style={{ color: "#b18c38" }}>Uploading photo to Cloudinary / storage...</small>}

            {/* Public Previews */}
            {Array.isArray(form.publicImages) && form.publicImages.length > 0 && (
              <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", margin: "10px 0" }}>
                {form.publicImages.map((url, idx) => (
                  <div key={idx} style={{ position: "relative", width: "70px", height: "70px" }}>
                    <img
                      src={getDisplayUrl(url)}
                      alt={`Item preview ${idx + 1}`}
                      style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: "6px", border: "1px solid #ddd" }}
                    />
                    <button
                      type="button"
                      onClick={() => removeImage(idx, false)}
                      style={{
                        position: "absolute",
                        top: "-5px",
                        right: "-5px",
                        background: "#b12d2d",
                        color: "white",
                        borderRadius: "50%",
                        width: "20px",
                        height: "20px",
                        border: "none",
                        cursor: "pointer",
                        fontSize: "12px",
                        lineHeight: "1"
                      }}
                      title="Remove image"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Private Verification Details (Requirement 5 & 6) */}
          <div className="form-row">
            <label>
              Secret marks / Serial # (Private)
              <input
                name="identifyingMarks"
                value={form.identifyingMarks || ""}
                onChange={updateForm}
                placeholder="e.g. Scratched logo, initials (never public)"
                maxLength={200}
              />
            </label>
            <label>
              Verification question (Optional)
              <input
                name="verificationQuestion"
                value={form.verificationQuestion || ""}
                onChange={updateForm}
                placeholder="e.g. What keychain is attached?"
                maxLength={200}
              />
            </label>
          </div>

          {/* Private Proof Photo Upload */}
          <div style={{ marginTop: "10px" }}>
            <label style={{ display: "block", marginBottom: "6px" }}>
              Private Verification Photo (Optional - never public)
              <input
                type="file"
                multiple
                accept="image/jpeg,image/png,image/webp,image/gif"
                onChange={(e) => handleFileUpload(e, true)}
                disabled={uploadingPrivate}
                style={{ marginTop: "6px", display: "block" }}
              />
            </label>
            {uploadingPrivate && <small style={{ color: "#b18c38" }}>Uploading private proof photo...</small>}

            {/* Private Previews */}
            {Array.isArray(form.privateImages) && form.privateImages.length > 0 && (
              <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", margin: "10px 0" }}>
                {form.privateImages.map((filename, idx) => (
                  <div key={filename} style={{ position: "relative", width: "70px", height: "70px" }}>
                    {privatePreviewUrls[filename] ? (
                      <img
                        src={privatePreviewUrls[filename]}
                        alt={`Private preview ${idx + 1}`}
                        style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: "6px", border: "2px dashed #b18c38" }}
                      />
                    ) : (
                      <span>Private photo {idx + 1}</span>
                    )}
                    <button
                      type="button"
                      onClick={() => removeImage(idx, true)}
                      style={{
                        position: "absolute",
                        top: "-5px",
                        right: "-5px",
                        background: "#b12d2d",
                        color: "white",
                        borderRadius: "50%",
                        width: "20px",
                        height: "20px",
                        border: "none",
                        cursor: "pointer",
                        fontSize: "12px",
                        lineHeight: "1"
                      }}
                      title="Remove image"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {uploadError && (
            <p style={{ color: "#b12d2d", fontSize: "12px", background: "#fdf0ed", padding: "8px", borderRadius: "6px" }}>
              {uploadError}
            </p>
          )}

          <label>
            Reporter
            <input
              name="reportedBy"
              type="number"
              min="1"
              value={form.reportedBy}
              onChange={updateForm}
              required
              readOnly={Boolean(currentUser)}
            />
            <small className="field-hint">
              {currentUser
                ? `Signed in as ${currentUser.name || "student"} (${currentUser.studentId})`
                : "Sign in to report an item with your campus account."}
            </small>
          </label>

          <button className="button button-dark submit-button" disabled={submitting || uploadingPublic || uploadingPrivate}>
            {submitting ? "Submitting report..." : "Submit report"} <span>↗</span>
          </button>
          <p className="privacy-note">
            Verification marks & private photos are protected and only viewed during verified handovers.
          </p>
        </form>
      </section>
    </div>
  );
}
