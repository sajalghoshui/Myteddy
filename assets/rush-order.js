class RushOrderCard extends HTMLElement {
  constructor() {
    super();
    this._busy = false;
  }

  connectedCallback() {
    this.checkbox = this.querySelector('.rush-order-card__checkbox');
    if (!this.checkbox || this._bound) return;
    this._bound = true;
    this.checkbox.addEventListener('change', this.onToggle.bind(this));
  }

  onToggle(event) {
    if (this._busy) {
      event.preventDefault();
      return;
    }
    const add = event.target.checked;
    this.setBusy(true);
    const action = add ? this.addRush() : this.removeRush();
    action
      .catch(() => {
        event.target.checked = !add;
      })
      .finally(() => this.setBusy(false));
  }

  setBusy(busy) {
    this._busy = busy;
    if (this.checkbox) this.checkbox.disabled = busy;
  }

  getSectionsPayload() {
    const sections = [];
    const seen = new Set();

    const push = (id, section, selector) => {
      const key = `${section}:${selector || id}`;
      if (seen.has(key)) return;
      seen.add(key);
      sections.push({ id, section, selector });
    };

    const drawerItems = document.querySelector('cart-drawer-items');
    if (drawerItems?.getSectionsToRender) {
      drawerItems.getSectionsToRender().forEach((s) => push(s.id, s.section, s.selector));
    }

    const cartItems = document.querySelector('cart-items');
    if (cartItems?.getSectionsToRender) {
      cartItems.getSectionsToRender().forEach((s) => push(s.id, s.section, s.selector));
    }

    return sections;
  }

  sectionsRequestBody() {
    const sectionsToRender = this.getSectionsPayload();
    return {
      sections: sectionsToRender.map((s) => s.section),
      sections_url: window.location.pathname,
      _sectionsToRender: sectionsToRender,
    };
  }

  getSectionInnerHTML(html, selector) {
    const node = new DOMParser().parseFromString(html, 'text/html').querySelector(selector);
    return node ? node.innerHTML : null;
  }

  async fetchFullCart() {
    if (typeof CartItems !== 'undefined' && CartItems.fetchCartData) {
      return CartItems.fetchCartData();
    }
    const response = await fetch(`${routes.cart_url}.json`, fetchConfig('json'));
    return response.json();
  }

  mergeCartState(mutationState, fullCart) {
    if (!fullCart) return mutationState;
    return {
      ...fullCart,
      sections: mutationState.sections,
    };
  }

  applySectionResponse(parsedState, sectionsToRender) {
    if (!parsedState.sections) return;

    sectionsToRender.forEach((section) => {
      const sectionHtml = parsedState.sections[section.section];
      if (!sectionHtml) return;
      const target = document.getElementById(section.id);
      if (!target) return;
      const mount = section.selector ? target.querySelector(section.selector) || target : target;
      const innerHTML = this.getSectionInnerHTML(sectionHtml, section.selector || '.shopify-section');
      if (innerHTML == null) return;
      mount.innerHTML = innerHTML;
    });

    const count = parsedState.item_count ?? 0;
    document.querySelector('cart-drawer')?.classList.toggle('is-empty', count === 0);
    document.getElementById('main-cart-footer')?.classList.toggle('is-empty', count === 0);
    document.querySelector('cart-items')?.classList.toggle('is-empty', count === 0);
  }

  async addRush() {
    const variantId = this.dataset.variantId;
    const { sections, sections_url, _sectionsToRender } = this.sectionsRequestBody();

    const body = JSON.stringify({
      items: [{ id: variantId, quantity: 1 }],
      sections,
      sections_url,
    });

    const response = await fetch(`${routes.cart_add_url}`, { ...fetchConfig(), body });
    const parsedState = await response.json();

    if (parsedState.status) {
      throw new Error(parsedState.description || parsedState.message);
    }

    const fullCart = await this.fetchFullCart();
    const stateForUi = this.mergeCartState(parsedState, fullCart);
    this.applySectionResponse(stateForUi, _sectionsToRender);
    await publish(PUB_SUB_EVENTS.cartUpdate, { source: 'rush-order', cartData: stateForUi, variantId });
  }

  async removeRush() {
    const line = parseInt(this.dataset.rushLine, 10);
    const variantId = this.dataset.variantId;
    const { sections, sections_url, _sectionsToRender } = this.sectionsRequestBody();

    let body;
    if (line > 0) {
      body = JSON.stringify({ line, quantity: 0, sections, sections_url });
    } else {
      body = JSON.stringify({ id: variantId, quantity: 0, sections, sections_url });
    }

    const response = await fetch(`${routes.cart_change_url}`, { ...fetchConfig(), body });
    const text = await response.text();
    const parsedState = JSON.parse(text);

    if (parsedState.errors) {
      throw new Error(parsedState.errors);
    }

    const fullCart = await this.fetchFullCart();
    const stateForUi = this.mergeCartState(parsedState, fullCart);
    this.applySectionResponse(stateForUi, _sectionsToRender);
    await publish(PUB_SUB_EVENTS.cartUpdate, { source: 'rush-order', cartData: stateForUi, variantId });
  }
}

customElements.define('rush-order-card', RushOrderCard);

class RushOrder {
  static get config() {
    return window.rushOrderConfig;
  }

  static rushProductId() {
    const productId = RushOrder.config?.productId;
    return productId == null ? null : String(productId);
  }

  static nonRushItems(items) {
    const productId = RushOrder.rushProductId();
    if (!productId || !items) return items || [];
    return items.filter((item) => String(item.product_id) !== productId && item.quantity > 0);
  }

  static rushItem(items) {
    const productId = RushOrder.rushProductId();
    if (!productId || !items) return null;
    return items.find((item) => String(item.product_id) === productId && item.quantity > 0);
  }

  /**
   * Removes the rush line when no other products remain. Returns updated cart JSON or null.
   */
  static async autoCleanup(parsedState, sectionsToRender) {
    if (!RushOrder.config || !parsedState?.items) return null;

    const nonRush = RushOrder.nonRushItems(parsedState.items);
    const rush = RushOrder.rushItem(parsedState.items);
    if (nonRush.length > 0 || !rush) return null;

    const line = parsedState.items.indexOf(rush) + 1;
    const body = JSON.stringify({
      line,
      quantity: 0,
      sections: sectionsToRender.map((s) => s.section),
      sections_url: window.location.pathname,
    });

    const response = await fetch(`${routes.cart_change_url}`, { ...fetchConfig(), body });
    const text = await response.text();
    const nextState = JSON.parse(text);
    if (nextState.errors) {
      console.error(nextState.errors);
      return null;
    }

    await publish(PUB_SUB_EVENTS.cartUpdate, { source: 'rush-order-auto', cartData: nextState });
    return nextState;
  }

  static paintSections(parsedState, sectionsToRender, cartItemsInstance) {
    if (!parsedState.sections) return;
    sectionsToRender.forEach((section) => {
      const elementToReplace =
        document.getElementById(section.id).querySelector(section.selector) ||
        document.getElementById(section.id);
      elementToReplace.innerHTML = cartItemsInstance.getSectionInnerHTML(
        parsedState.sections[section.section],
        section.selector
      );
    });
  }
}

window.RushOrder = RushOrder;
