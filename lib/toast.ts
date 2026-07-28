/**
 * The in-page prompt shown when something finishes.
 *
 * This is the moment worth asking at. The confirm queue works, but it asks
 * later, out of context, when the film is no longer in mind - and a rating
 * given at the credits is worth more than one reconstructed a week later.
 *
 * Rendered into a closed shadow root so the host page's CSS can't reach in and
 * ours can't leak out. Streaming sites carry aggressive global styles and some
 * of them would happily restyle or hide this.
 *
 * Deliberately not a modal, an `alert`, or anything that steals focus. It sits
 * in a corner, it can be ignored, and ignoring it leaves the detection safely
 * in the confirm queue rather than discarding it.
 */

export interface ToastOptions {
  title: string;
  year?: number;
  /** The question. Defaults to the tracking prompt. */
  prompt?: string;
  confirmLabel?: string;
  dismissLabel?: string;
  /** Stars only make sense for something being watched, not something saved. */
  showStars?: boolean;
  /** Called with a rating (1-5) or null when the user just says yes. */
  onConfirm: (rating: number | null) => void;
  onDismiss: () => void;
  /** Called when the toast is closed without an answer. */
  onIgnore: () => void;
}

const HOST_ID = 'keeper-toast-host';
const VISIBLE_MS = 45_000;

const STYLES = `
  :host { all: initial; }
  .card {
    display: flex;
    flex-direction: column;
    gap: 10px;
    width: 300px;
    padding: 14px 16px;
    border-radius: 12px;
    background: #16161a;
    color: #f2f2f4;
    box-shadow: 0 8px 32px rgba(0,0,0,0.45);
    font: 13px/1.45 system-ui, -apple-system, 'Segoe UI', sans-serif;
  }
  .brand { font-size: 10.5px; letter-spacing: .06em; text-transform: uppercase; color: #9a9aa5; }
  .title { font-size: 14.5px; font-weight: 600; }
  .year { color: #9a9aa5; font-weight: 400; }
  .stars { display: flex; gap: 2px; }
  .star {
    padding: 0 2px; border: 0; background: none; color: #3a3a44;
    font-size: 18px; line-height: 1; cursor: pointer;
  }
  .star.on { color: #f5a623; }
  .row { display: flex; gap: 6px; }
  button.act {
    flex: 1; padding: 7px 10px; border: 1px solid #2a2a31; border-radius: 7px;
    background: #1e1e24; color: #f2f2f4; font: inherit; font-weight: 500; cursor: pointer;
  }
  button.act.primary { border-color: transparent; background: #5b9bff; color: #0b0b0d; }
  .close {
    position: absolute; top: 8px; right: 10px; border: 0; background: none;
    color: #9a9aa5; font-size: 15px; line-height: 1; cursor: pointer;
  }
  .wrap { position: relative; }
`;

export function showToast(options: ToastOptions): void {
  document.getElementById(HOST_ID)?.remove();

  const host = document.createElement('div');
  host.id = HOST_ID;
  // Max z-index and fixed positioning: players go fullscreen and will otherwise
  // paint straight over this.
  // Top right: players put their own controls along the bottom edge, and a
  // bottom-corner toast lands on top of them.
  host.style.cssText = [
    'position:fixed',
    'right:20px',
    'top:20px',
    'z-index:2147483647',
    'width:auto',
    'height:auto',
  ].join(';');

  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = STYLES;

  const wrap = document.createElement('div');
  wrap.className = 'wrap';

  const card = document.createElement('div');
  card.className = 'card';

  const brand = document.createElement('div');
  brand.className = 'brand';
  brand.textContent = 'Keeper';

  const title = document.createElement('div');
  title.className = 'title';
  // textContent, never innerHTML - the title came off a page we don't control.
  title.textContent = options.title;
  if (options.year) {
    const year = document.createElement('span');
    year.className = 'year';
    year.textContent = ` ${options.year}`;
    title.appendChild(year);
  }

  const prompt = document.createElement('div');
  // Asked at detection now, not at the end - so this settles what is playing,
  // not whether it was finished. Coverage still decides that.
  prompt.textContent = options.prompt ?? 'Tracking this - is that right?';

  let rating: number | null = null;
  const stars = document.createElement('div');
  stars.className = 'stars';
  const starButtons: HTMLButtonElement[] = [];

  for (let value = 1; value <= 5; value++) {
    const star = document.createElement('button');
    star.className = 'star';
    star.textContent = '★';
    star.title = `${value} star${value > 1 ? 's' : ''}`;
    star.addEventListener('click', () => {
      // Tapping the same star again clears it. Rating stays optional.
      rating = rating === value ? null : value;
      starButtons.forEach((button, index) => {
        button.className = rating !== null && index < rating ? 'star on' : 'star';
      });
    });
    starButtons.push(star);
    stars.appendChild(star);
  }

  const close = () => host.remove();

  const confirm = document.createElement('button');
  confirm.className = 'act primary';
  confirm.textContent = options.confirmLabel ?? 'Yes, track it';
  confirm.addEventListener('click', () => {
    options.onConfirm(rating);
    close();
  });

  const dismiss = document.createElement('button');
  dismiss.className = 'act';
  dismiss.textContent = options.dismissLabel ?? 'Not me';
  dismiss.addEventListener('click', () => {
    options.onDismiss();
    close();
  });

  const closeButton = document.createElement('button');
  closeButton.className = 'close';
  closeButton.title = 'Ask me later';
  closeButton.textContent = '×';
  closeButton.addEventListener('click', () => {
    options.onIgnore();
    close();
  });

  const row = document.createElement('div');
  row.className = 'row';
  row.append(confirm, dismiss);

  // Stars are for something being watched. Saving a title for later says
  // nothing about whether it was any good.
  card.append(brand, title, prompt);
  if (options.showStars !== false) card.append(stars);
  card.append(row);
  wrap.append(card, closeButton);
  shadow.append(style, wrap);
  document.documentElement.appendChild(host);

  // Timing out leaves the detection in the confirm queue rather than dropping
  // it - being ignored must never mean being discarded.
  setTimeout(() => {
    if (document.getElementById(HOST_ID) === host) {
      options.onIgnore();
      close();
    }
  }, VISIBLE_MS);
}
