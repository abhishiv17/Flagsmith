import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { cityName, inr, type LiveItem, type SearchItem } from '../api';
import { useCart, useToast } from '../state';
import { kitStory, useGsap } from '../motion';
import { ProductImage } from './ProductImage';
import { cutoutFor } from '../productPhotos';

/**
 * "The commute kit": a pinned, scroll-scrubbed product story in three chapters, after the
 * exploded-view "ingredient ballet" pattern. A hero product appears, its companions spiral out
 * around it with leader-line labels (name, price, live stock), then everything drops into a bag.
 */

/** Orbit slots as % offsets from the stage centre (x of width, y of height): four corners. */
const SLOTS = [
  { x: -33, y: -30 },
  { x: 33, y: -30 },
  { x: 33, y: 24 },
  { x: -33, y: 24 },
];

function qtyOf(item: SearchItem, live?: LiveItem) {
  return live && live.stockVersion >= item.stockVersion ? live.qty : item.qty;
}

export function KitStory({ hero, kit, live, city }: {
  hero: SearchItem;
  kit: SearchItem[];
  live: Map<number, LiveItem>;
  city: string;
}) {
  const ref = useRef<HTMLElement>(null);
  const { add } = useCart();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  const all = [hero, ...kit];
  // CC BY-SA requires visible attribution; list every cut-out shown here.
  const credits = all.map((i) => cutoutFor(i.imageKey, i.sku)).filter((c): c is NonNullable<typeof c> => Boolean(c));
  const buyable = all.filter((i) => qtyOf(i, live.get(i.productId)) > 0);
  const total = buyable.reduce((n, i) => n + i.pricePaise, 0);

  useGsap(() => (ref.current ? kitStory(ref.current) : undefined), [kit.length, hero.productId], ref);

  const addKit = async () => {
    setBusy(true);
    let added = 0;
    for (const i of buyable) {
      try {
        if (await add(i.productId, 1)) added += 1; // a refused item opens the "out of stock for you" popup
      } catch {
        /* one sold-out item shouldn't stop the rest */
      }
    }
    setBusy(false);
    toast(
      added === buyable.length ? `Added the commute kit: ${added} items` : `Added ${added} of ${buyable.length} items. Some just sold out.`,
      { label: 'View cart', to: '/cart' },
    );
  };

  return (
    <section className="kit" ref={ref} aria-labelledby="kit-title">
      <div className="kit-stage">
        <ol className="kit-index" aria-hidden="true">
          <li className="is-active"><span>01</span> The pick</li>
          <li><span>02</span> The kit</li>
          <li><span>03</span> Your bag</li>
          <span className="kit-progress"><span /></span>
        </ol>

        <div className="kit-copy">
          <div className="kit-chapter" data-chapter="1">
            <p className="kit-eyebrow">The commute kit</p>
            <h2 id="kit-title">One great pair of headphones.</h2>
            <p>Start with the thing you’ll use every single day.</p>
          </div>
          <div className="kit-chapter" data-chapter="2">
            <h2>Everything it travels with.</h2>
            <p>Each piece is on a shelf in {cityName(city)} right now. The counts are live.</p>
          </div>
          <div className="kit-chapter" data-chapter="3">
            <h2>Packed and ready.</h2>
            <p>{buyable.length} items, {inr(total)}. Checkout secures every unit.</p>
            <div className="kit-actions">
              <button className="btn btn-primary btn-lg" onClick={addKit} disabled={busy || buyable.length === 0}>
                {busy ? 'Adding…' : 'Add the kit to cart'}
              </button>
              <Link to="/shop" className="text-link">Pick your own</Link>
            </div>
          </div>
        </div>

        <div className="kit-scene">
          <div className="kit-orbit">
            {kit.map((item, i) => {
              const slot = SLOTS[i % SLOTS.length]!;
              const qty = qtyOf(item, live.get(item.productId));
              const side = slot.x < 0 ? 'left' : 'right';
              return (
                <Link
                  key={item.productId}
                  to={`/p/${item.productId}`}
                  className={`kit-orb side-${side}`}
                  data-x={slot.x}
                  data-y={slot.y}
                  style={{ ['--x' as string]: `${slot.x}%`, ['--y' as string]: `${slot.y}%` }}
                >
                  <span className={cutoutFor(item.imageKey, item.sku) ? 'orb-img is-cutout' : 'orb-img'}>
                    <ProductImage imageKey={item.imageKey} productId={item.productId} sku={item.sku} name={item.name} cutout />
                  </span>
                  <span className="orb-label">
                    <b>{item.name}</b>
                    <span>
                      {inr(item.pricePaise)},{' '}
                      <span className={qty <= 2 ? 'orb-qty low' : 'orb-qty'}>{qty > 0 ? `${qty} left` : 'sold out here'}</span>
                    </span>
                  </span>
                </Link>
              );
            })}
          </div>

          <Link
            to={`/p/${hero.productId}`}
            className={cutoutFor(hero.imageKey, hero.sku) ? 'kit-hero is-cutout' : 'kit-hero'}
            aria-label={hero.name}
          >
            <ProductImage imageKey={hero.imageKey} productId={hero.productId} sku={hero.sku} name={hero.name} priority cutout />
          </Link>

          <div className="kit-bag" aria-hidden="true">
            <svg viewBox="0 0 120 120">
              <path d="M22 40h76l-6 62a8 8 0 0 1-8 7H36a8 8 0 0 1-8-7L22 40Z" />
              <path d="M44 48V34a16 16 0 0 1 32 0v14" fill="none" />
            </svg>
            <span className="kit-bag-count">{buyable.length}</span>
          </div>
        </div>
      </div>
      {credits.length > 0 && (
        <p className="kit-credits">
          Cut-out images via Wikimedia Commons:{' '}
          {credits.map((c, i) => (
            <span key={c.sourceUrl}>
              {i > 0 && '; '}
              <a href={c.sourceUrl} target="_blank" rel="noreferrer">{c.credit.replace(', via Wikimedia Commons', '')}</a>
            </span>
          ))}
          .
        </p>
      )}
    </section>
  );
}
