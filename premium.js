/* Coco Rush premium interaction layer — no commerce/payment logic changed. */
(function () {
  'use strict';
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const root = document.documentElement;
  const nav = document.querySelector('.navbar');

  function makeProgress() {
    const bar = document.createElement('div');
    bar.className = 'lux-progress';
    bar.setAttribute('aria-hidden', 'true');
    document.body.appendChild(bar);
    const update = () => {
      const scrollable = document.documentElement.scrollHeight - window.innerHeight;
      bar.style.width = `${scrollable > 0 ? (window.scrollY / scrollable) * 100 : 0}%`;
      if (nav) nav.classList.toggle('is-scrolled', window.scrollY > 18);
    };
    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update, { passive: true });
  }

  function reveal() {
    const nodes = document.querySelectorAll('.reveal-on-scroll, .section-header, .product-hero .buy-box, .product-hero .hero-gallery');
    if (reduce || !('IntersectionObserver' in window)) {
      nodes.forEach((node) => node.classList.add('is-visible'));
      return;
    }
    const io = new IntersectionObserver((entries, observer) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
    nodes.forEach((node, index) => {
      node.style.transitionDelay = `${Math.min(index % 6, 5) * 55}ms`;
      io.observe(node);
    });
  }

  function cursorMoment() {
    if (reduce || !window.matchMedia('(pointer:fine)').matches) return;
    const orb = document.createElement('div');
    orb.className = 'lux-cursor';
    orb.setAttribute('aria-hidden', 'true');
    document.body.appendChild(orb);
    let x = -100, y = -100, tx = -100, ty = -100;
    const tick = () => {
      x += (tx - x) * .18; y += (ty - y) * .18;
      orb.style.left = `${x}px`; orb.style.top = `${y}px`;
      requestAnimationFrame(tick);
    };
    tick();
    window.addEventListener('pointermove', (event) => {
      tx = event.clientX; ty = event.clientY;
      orb.classList.add('is-visible');
    }, { passive: true });
    window.addEventListener('pointerout', (event) => {
      if (!event.relatedTarget) orb.classList.remove('is-visible');
    });
    document.addEventListener('pointerover', (event) => {
      if (event.target.closest('a,button,.variant-btn,.thumb,.offer-card,.insta-card')) orb.classList.add('is-hovering');
    });
    document.addEventListener('pointerout', (event) => {
      if (event.target.closest('a,button,.variant-btn,.thumb,.offer-card,.insta-card')) orb.classList.remove('is-hovering');
    });
  }

  function heroParallax() {
    if (reduce || !window.matchMedia('(pointer:fine)').matches) return;
    const gallery = document.querySelector('.hero-gallery');
    const image = document.querySelector('.gallery-main img');
    if (!gallery || !image) return;
    let raf = 0;
    window.addEventListener('pointermove', (event) => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const rect = gallery.getBoundingClientRect();
        if (rect.bottom < 0 || rect.top > window.innerHeight) return;
        const px = (event.clientX / window.innerWidth - .5) * 8;
        const py = (event.clientY / window.innerHeight - .5) * 8;
        image.style.transform = `scale(1.035) translate3d(${px}px, ${py}px, 0)`;
      });
    }, { passive: true });
  }

  function smoothAnchors() {
    document.addEventListener('click', (event) => {
      const link = event.target.closest('a[href^="#"]');
      if (!link) return;
      const id = link.getAttribute('href');
      if (!id || id === '#') return;
      const target = document.querySelector(id);
      if (!target) return;
      event.preventDefault();
      target.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    });
  }


  function addCinematicStory() {
    const source = 'assam-coco-story.mp4';
    const hero = document.querySelector('.product-hero');
    if (hero && !hero.querySelector('.coco-hero-film')) {
      const video = document.createElement('video');
      video.className = 'coco-hero-film';
      video.autoplay = true; video.muted = true; video.loop = true; video.playsInline = true;
      video.preload = 'metadata'; video.setAttribute('aria-hidden', 'true');
      video.innerHTML = `<source src="${source}" type="video/mp4">`;
      hero.prepend(video);
      const shade = document.createElement('div');
      shade.className = 'coco-film-shade'; shade.setAttribute('aria-hidden', 'true');
      hero.prepend(shade);
    }
    const anchor = document.querySelector('.stat-strip');
    if (anchor && !document.querySelector('.coco-film-break')) {
      const story = document.createElement('section');
      story.className = 'coco-film-break';
      story.setAttribute('aria-label', 'The Coco Rush story');
      story.innerHTML = `<video autoplay muted loop playsinline preload="metadata" aria-hidden="true"><source src="${source}" type="video/mp4"></video><div class="coco-film-copy"><div class="section-eyebrow">From Assam, for everywhere</div><h2>Born where green meets water.</h2><p>Coco Rush brings the feeling of tender coconut water into a pocket-sized ritual — a little freshness from the Northeast, ready wherever the day takes you.</p><div class="coco-film-meta"><span>Assam inspired</span><span>Real coconut concentrate</span><span>Ready in 10 seconds</span></div></div>`;
      anchor.parentNode.insertBefore(story, anchor);
      const copy = story.querySelector('.coco-film-copy');
      if (copy && !reduce) {
        copy.style.opacity = '0'; copy.style.transform = 'translateY(26px)';
        const io = new IntersectionObserver((entries, observer) => {
          if (!entries[0].isIntersecting) return;
          copy.style.opacity = '1'; copy.style.transform = 'none';
          copy.style.transition = 'opacity .9s ease, transform 1s var(--ease-lux)';
          observer.disconnect();
        }, { threshold: .2 });
        io.observe(story);
      }
    }
  }

  function init() {
    addCinematicStory();
    makeProgress();
    reveal();
    cursorMoment();
    heroParallax();
    smoothAnchors();
    root.classList.add('premium-ready');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
