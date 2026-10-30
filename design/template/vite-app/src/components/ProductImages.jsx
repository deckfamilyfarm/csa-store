import React, { useState } from "react";
import { adminPost, adminUploadImage } from "../adminApi.js";

export function ProductImages({ productId, token, images, name, disabled, onBusy, onImages }) {
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  async function run(operation) {
    setWorking(true); onBusy?.(true); setError("");
    try { await operation(); } catch (error) { setError(error.message); }
    finally { setWorking(false); onBusy?.(false); }
  }
  return <div><h4>Photos</h4>
    <div className="product-editor-images">{images.map((image, index) => {
      const item = typeof image === "string" ? { url: image } : image;
      return <div key={item.url || index}><img src={item.thumbnailUrl || item.url} alt={name} loading="lazy" />
        <button type="button" className="button alt" disabled={disabled || working} onClick={() => run(async () => {
          await adminPost(`products/${productId}/images/delete`, token, { url: item.url, thumbnailUrl: item.thumbnailUrl });
          onImages(images.filter((_, i) => i !== index));
        })}>Remove photo</button></div>;
    })}</div>
    <label>Add photo<input type="file" accept="image/*" disabled={disabled || working} onChange={event => {
      const file = event.target.files?.[0]; event.target.value = "";
      if (file) run(async () => { const image = await adminUploadImage(productId, token, file); onImages([...images, image]); });
    }} /></label>
    <p className="small">Photo changes save immediately. Publish them through Sync.</p>
    {error && <p role="alert">{error}</p>}
  </div>;
}
