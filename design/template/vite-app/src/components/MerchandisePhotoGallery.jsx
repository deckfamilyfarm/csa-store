import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

function PhotoDialog({ images, name, photo, onPhoto, onClose }) {
  const dialog = useRef(null);
  const titleId = useId();
  const countId = useId();
  const move = direction => onPhoto(current => (current + direction + images.length) % images.length);
  useEffect(() => {
    const element = dialog.current;
    const focused = document.activeElement;
    const overflow = document.body.style.overflow;
    element.showModal();
    document.body.style.overflow = 'hidden';
    return () => {
      element.close();
      document.body.style.overflow = overflow;
      if (focused?.isConnected) focused.focus({ preventScroll: true });
    };
  }, []);
  return createPortal(<dialog ref={dialog} className="merch-photo-dialog" aria-labelledby={titleId} aria-describedby={countId}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
    }}
    onKeyDown={event => {
      if (images.length < 2) return;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault(); move(event.key === 'ArrowLeft' ? -1 : 1);
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault(); onPhoto(event.key === 'Home' ? 0 : images.length - 1);
      }
    }}>
    <header className="merch-photo-header"><h2 id={titleId}>{name}</h2>
      <button type="button" autoFocus onClick={onClose} aria-label="Close enlarged photos">Close</button>
    </header>
    <div className="merch-photo-stage"><img src={images[photo].src} alt={`${name}, photo ${photo + 1}`} /></div>
    <footer className="merch-photo-footer">
      <div className="merch-photo-navigation">
        {images.length > 1 && <button type="button" onClick={() => move(-1)}>Previous photo</button>}
        <span id={countId} role="status" aria-live="polite" aria-atomic="true">Photo {photo + 1} of {images.length}</span>
        {images.length > 1 && <button type="button" onClick={() => move(1)}>Next photo</button>}
      </div>
      {images.length > 1 && <div className="merch-photo-thumbnails" role="group" aria-label="Choose a product photo">
        {images.map((image, index) => <button key={`${image.src}:${index}`} type="button" aria-label={`Show photo ${index + 1} of ${name}`}
          aria-current={photo === index ? 'true' : undefined} onClick={() => onPhoto(index)}>
          <img src={image.src} alt="" loading="lazy" />
        </button>)}
      </div>}
    </footer>
  </dialog>, document.body);
}

export function MerchandisePhotoGallery({ images, name }) {
  const [photo, setPhoto] = useState(0);
  const [open, setOpen] = useState(false);
  if (!images.length) return null;
  const current = photo % images.length;
  return <>
    <div className="merch-gallery"><button type="button" className="merch-gallery-trigger" aria-label={`View enlarged photos of ${name}`}
      aria-haspopup="dialog" onClick={() => setOpen(true)}>
      <img src={images[current].src} alt={name} loading="lazy" />
    </button></div>
    {open && <PhotoDialog images={images} name={name} photo={current} onPhoto={setPhoto} onClose={() => setOpen(false)} />}
  </>;
}
