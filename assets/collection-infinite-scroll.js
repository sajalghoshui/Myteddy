/**
 * Collection product grid infinite scroll.
 * Fetches paginate.next URLs and appends grid items; re-inits after facet updates.
 */
(function () {
  const SENTINEL_ID = 'CollectionInfiniteScrollSentinel';
  const STATUS_ID = 'CollectionInfiniteScrollStatus';
  const GRID_ID = 'product-grid';

  if (!document.querySelector('collection-component') || !document.getElementById(GRID_ID)) {
    return;
  }

  class CollectionInfiniteScroll {
    constructor() {
      this.loading = false;
      this.observer = null;
      this.productKeys = new Set();
      this.onIntersect = this.onIntersect.bind(this);
      this.init();
    }

    init() {
      this.resetFromDOM();
      this.setupObserver();
      this.hookFacetUpdates();
    }

    getScrollRoot() {
      return document.querySelector('.collection-infinite-scroll');
    }

    getNextUrl() {
      const root = this.getScrollRoot();
      return root?.dataset.infiniteScrollNext?.trim() || '';
    }

    setNextUrl(url) {
      const root = this.getScrollRoot();
      if (!root) return;
      if (url) {
        root.dataset.infiniteScrollNext = url;
      } else {
        delete root.dataset.infiniteScrollNext;
      }
    }

    collectProductKeys() {
      const grid = document.getElementById(GRID_ID);
      if (!grid) return new Set();

      const keys = new Set();
      grid.querySelectorAll(':scope > li.grid__item').forEach((item) => {
        const key = this.getProductKey(item);
        if (key) keys.add(key);
      });
      return keys;
    }

    getProductKey(listItem) {
      return (
        listItem.querySelector('[data-wlh-id]')?.getAttribute('data-wlh-id') ||
        listItem.querySelector('[data-product-id]')?.getAttribute('data-product-id') ||
        listItem.querySelector('a[href*="/products/"]')?.getAttribute('href') ||
        null
      );
    }

    resetFromDOM() {
      this.loading = false;
      this.productKeys = this.collectProductKeys();
      this.setLoadingVisible(false);
      this.setupObserver();
    }

    setupObserver() {
      const sentinel = document.getElementById(SENTINEL_ID);
      if (this.observer) {
        this.observer.disconnect();
        this.observer = null;
      }
      if (!sentinel || !this.getNextUrl()) return;

      this.observer = new IntersectionObserver(this.onIntersect, {
        root: null,
        rootMargin: '400px 0px',
        threshold: 0,
      });
      this.observer.observe(sentinel);
    }

    onIntersect(entries) {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      this.loadNextPage();
    }

    setLoadingVisible(visible) {
      const status = document.getElementById(STATUS_ID);
      const spinner = status?.querySelector('.loading__spinner');
      if (!status || !spinner) return;
      spinner.classList.toggle('hidden', !visible);
      status.hidden = !visible;
    }

    parseSectionHtml(html) {
      return new DOMParser().parseFromString(html, 'text/html');
    }

    extractNextUrl(doc) {
      return doc.querySelector('.collection-infinite-scroll')?.dataset.infiniteScrollNext?.trim() || '';
    }

    extractNewGridItems(doc) {
      const sectionId = document.getElementById(GRID_ID)?.dataset.id;
      const fetchedGrid =
        (sectionId && doc.querySelector(`#${GRID_ID}[data-id="${sectionId}"]`)) || doc.getElementById(GRID_ID);
      if (!fetchedGrid) return [];

      return Array.from(fetchedGrid.querySelectorAll(':scope > li.grid__item'));
    }

    refreshWishlistAndApps() {
      document.dispatchEvent(new CustomEvent('wishlist:refresh'));
      document.dispatchEvent(new Event('swym:collections-loaded'));

      const hero = window.WishlistHero;
      if (hero && typeof hero === 'object') {
        ['refreshCollectionButtons', 'initCollectionButtons', 'init', 'initialize', 'refresh', 'reload'].forEach(
          (method) => {
            if (typeof hero[method] === 'function') hero[method]();
          },
        );
      }

      if (Array.isArray(window.SwymCallbacks)) {
        window.SwymCallbacks.forEach((cb) => {
          try {
            cb(window._swat);
          } catch (e) {
            /* Swym callback optional */
          }
        });
      }
    }

    hookFacetUpdates() {
      const patch = () => {
        if (typeof FacetFiltersForm === 'undefined' || FacetFiltersForm.__collectionInfiniteScrollPatched) return false;

        const original = FacetFiltersForm.renderProductGridContainer.bind(FacetFiltersForm);
        FacetFiltersForm.renderProductGridContainer = (html) => {
          original(html);
          this.resetFromDOM();
          document.dispatchEvent(new CustomEvent('collection:infinite-scroll-reset'));
        };
        FacetFiltersForm.__collectionInfiniteScrollPatched = true;
        return true;
      };

      if (!patch()) {
        document.addEventListener('DOMContentLoaded', () => patch(), { once: true });
      }
    }

    async loadNextPage() {
      const nextUrl = this.getNextUrl();
      if (!nextUrl || this.loading) return;

      this.loading = true;
      this.setLoadingVisible(true);

      try {
        const response = await fetch(nextUrl);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const html = await response.text();
        const doc = this.parseSectionHtml(html);
        const items = this.extractNewGridItems(doc);
        const grid = document.getElementById(GRID_ID);

        if (grid && items.length) {
          const fragment = document.createDocumentFragment();
          items.forEach((item) => {
            const key = this.getProductKey(item);
            if (key && this.productKeys.has(key)) return;
            if (key) this.productKeys.add(key);
            fragment.appendChild(document.importNode(item, true));
          });
          grid.appendChild(fragment);

          if (typeof initializeScrollAnimationTrigger === 'function') {
            initializeScrollAnimationTrigger();
          }

          this.refreshWishlistAndApps();
        }

        const newNextUrl = this.extractNextUrl(doc);
        this.setNextUrl(newNextUrl);

        if (history.replaceState) {
          history.replaceState(history.state, '', nextUrl);
        }

        this.setupObserver();
      } catch (error) {
        console.error('Collection infinite scroll:', error);
        this.setNextUrl('');
        this.setupObserver();
      } finally {
        this.loading = false;
        this.setLoadingVisible(false);
      }
    }
  }

  const instance = new CollectionInfiniteScroll();
  window.CollectionInfiniteScroll = instance;
})();
