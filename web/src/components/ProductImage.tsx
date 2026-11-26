import { useState } from 'react';
import { cutoutFor, photoFor } from '../productPhotos';
import { ProductArt } from './ProductArt';

/**
 * Realistic photo when one is registered in productPhotos.ts, otherwise the SVG illustration.
 * Also falls back if the file fails to load, so a missing photo never shows a broken image.
 */
export function ProductImage({ imageKey, productId, sku, name, priority = false, credit = false, cutout = false }: {
  imageKey: string;
  productId: number;
  sku?: string;
  name: string;
  /** Load eagerly (above the fold, e.g. the product page hero). */
  priority?: boolean;
  /** Show the photographer credit over the photo (product page). */
  credit?: boolean;
  /** Prefer a transparent cut-out (floating layouts), falling back to the photo. */
  cutout?: boolean;
}) {
  const cut = cutout ? cutoutFor(imageKey, sku) : null;
  const photo = photoFor(imageKey, sku);
  const [failed, setFailed] = useState(false);
  const [cutFailed, setCutFailed] = useState(false);

  if (cut && !cutFailed) {
    return (
      <div className="art art-cutout">
        <img src={cut.src} alt={name} loading={priority ? 'eager' : 'lazy'} decoding="async" referrerPolicy="no-referrer" onError={() => setCutFailed(true)} />
      </div>
    );
  }

  if (!photo || failed) return <ProductArt imageKey={imageKey} productId={productId} />;

  return (
    <div className="art art-photo">
      <img
        src={photo.src}
        alt={name}
        loading={priority ? 'eager' : 'lazy'}
        decoding="async"
        referrerPolicy="no-referrer"
        style={photo.focus ? { objectPosition: photo.focus } : undefined}
        onError={() => setFailed(true)}
      />
      {credit && (
        <a className="photo-credit" href={photo.sourceUrl} target="_blank" rel="noreferrer">
          Photo: {photo.credit}
        </a>
      )}
    </div>
  );
}
