class EmbroideryTemplateCart {
  static lineProperties(item) {
    const raw = item?.properties;
    if (!raw) return {};
    if (!Array.isArray(raw)) return raw;
    const props = {};
    raw.forEach((entry) => {
      const key = entry?.key ?? entry?.first ?? entry?.name;
      const value = entry?.value ?? entry?.last;
      if (key != null) props[key] = value;
    });
    return props;
  }

  static isAddonLine(item) {
    const props = EmbroideryTemplateCart.lineProperties(item);
    const flag = props._embroidery_template_addon;
    if (flag !== true && flag !== 'true') return false;
    return Boolean(props._embroidery_template_parent);
  }

  static parentProductIdFromLine(item) {
    return String(EmbroideryTemplateCart.lineProperties(item)._embroidery_template_parent || '');
  }

  static parentProductQuantity(items, parentProductId) {
    if (!items || !parentProductId) return 0;
    return items
      .filter((item) => !EmbroideryTemplateCart.isAddonLine(item) && String(item.product_id) === parentProductId)
      .reduce((sum, item) => sum + (item.quantity || 0), 0);
  }

  static getSectionsPayload() {
    const sections = [];
    const seen = new Set();
    const push = (id, section, selector) => {
      const key = `${section}:${selector || id}`;
      if (seen.has(key)) return;
      seen.add(key);
      sections.push({ id, section, selector });
    };

    document.querySelector('cart-drawer-items')?.getSectionsToRender?.().forEach((s) => push(s.id, s.section, s.selector));
    document.querySelector('cart-items')?.getSectionsToRender?.().forEach((s) => push(s.id, s.section, s.selector));

    return sections;
  }

  static sectionsRequestBody() {
    const sectionsToRender = EmbroideryTemplateCart.getSectionsPayload();
    return {
      sections: sectionsToRender.map((s) => s.section),
      sections_url: window.location.pathname,
      _sectionsToRender: sectionsToRender,
    };
  }

  static getSectionInnerHTML(html, selector) {
    const node = new DOMParser().parseFromString(html, 'text/html').querySelector(selector);
    return node ? node.innerHTML : null;
  }

  static async fetchFullCart() {
    if (typeof CartItems !== 'undefined' && CartItems.fetchCartData) {
      return CartItems.fetchCartData();
    }
    const response = await fetch(`${routes.cart_url}.json`, fetchConfig('json'));
    return response.json();
  }

  static mergeCartState(mutationState, fullCart) {
    if (!fullCart) return mutationState;
    return { ...fullCart, sections: mutationState.sections };
  }

  static applySectionResponse(parsedState, sectionsToRender) {
    if (!parsedState?.sections) return;

    sectionsToRender.forEach((section) => {
      const sectionHtml = parsedState.sections[section.section];
      if (!sectionHtml) return;
      const target = document.getElementById(section.id);
      if (!target) return;
      const mount = section.selector ? target.querySelector(section.selector) || target : target;
      const innerHTML = EmbroideryTemplateCart.getSectionInnerHTML(sectionHtml, section.selector || '.shopify-section');
      if (innerHTML == null) return;
      mount.innerHTML = innerHTML;
    });

    const count = parsedState.item_count ?? 0;
    document.querySelector('cart-drawer')?.classList.toggle('is-empty', count === 0);
    document.getElementById('main-cart-footer')?.classList.toggle('is-empty', count === 0);
    document.querySelector('cart-items')?.classList.toggle('is-empty', count === 0);
  }

  static addonLinesForParent(cart, parentProductId) {
    if (!cart?.items) return [];
    return cart.items.filter(
      (item) =>
        EmbroideryTemplateCart.isAddonLine(item) &&
        EmbroideryTemplateCart.parentProductIdFromLine(item) === String(parentProductId)
    );
  }

  static async removeAddonLinesByIndex(cart, lineIndexes, sectionsToRender = null) {
    let lastState = null;
    const sortedLines = [...lineIndexes].sort((a, b) => b - a);
    for (const line of sortedLines) {
      const payload = { line, quantity: 0 };
      if (sectionsToRender?.length) {
        payload.sections = sectionsToRender.map((s) => s.section);
        payload.sections_url = window.location.pathname;
      }
      const body = JSON.stringify(payload);
      const response = await fetch(`${routes.cart_change_url}`, { ...fetchConfig(), body });
      const text = await response.text();
      lastState = JSON.parse(text);
      if (lastState.errors) throw new Error(lastState.errors);
    }
    return lastState;
  }

  static async removeAddonsForParent(parentProductId) {
    const cart = await EmbroideryTemplateCart.fetchFullCart();
    const linesToRemove = [];
    cart.items?.forEach((item, index) => {
      if (
        EmbroideryTemplateCart.isAddonLine(item) &&
        EmbroideryTemplateCart.parentProductIdFromLine(item) === String(parentProductId)
      ) {
        linesToRemove.push(index + 1);
      }
    });
    if (linesToRemove.length === 0) return null;
    return EmbroideryTemplateCart.removeAddonLinesByIndex(cart, linesToRemove);
  }

  static async addAddonVariant({ variantId, parentProductId }) {
    const { sections, sections_url, _sectionsToRender } = EmbroideryTemplateCart.sectionsRequestBody();

    await EmbroideryTemplateCart.removeAddonsForParent(parentProductId);

    const body = JSON.stringify({
      items: [
        {
          id: variantId,
          quantity: 1,
          properties: {
            _embroidery_template_addon: 'true',
            _embroidery_template_parent: String(parentProductId),
          },
        },
      ],
      sections,
      sections_url,
    });

    const response = await fetch(`${routes.cart_add_url}`, { ...fetchConfig(), body });
    const parsedState = await response.json();

    if (parsedState.status) {
      throw new Error(parsedState.description || parsedState.message);
    }

    const fullCart = await EmbroideryTemplateCart.fetchFullCart();
    const stateForUi = EmbroideryTemplateCart.mergeCartState(parsedState, fullCart);
    EmbroideryTemplateCart.applySectionResponse(stateForUi, _sectionsToRender);
    await publish(PUB_SUB_EVENTS.cartUpdate, {
      source: 'embroidery-template-addon',
      cartData: stateForUi,
      variantId,
    });
    return stateForUi;
  }

  static async autoCleanup(parsedState, sectionsToRender) {
    if (!parsedState) return null;

    const fullCart = await EmbroideryTemplateCart.fetchFullCart();
    const items = fullCart?.items?.length ? fullCart.items : parsedState.items;
    if (!items?.length) return null;

    const linesToRemove = [];
    items.forEach((item, index) => {
      if (!EmbroideryTemplateCart.isAddonLine(item)) return;
      const parentId = EmbroideryTemplateCart.parentProductIdFromLine(item);
      if (EmbroideryTemplateCart.parentProductQuantity(items, parentId) <= 0) {
        linesToRemove.push(index + 1);
      }
    });

    if (linesToRemove.length === 0) return null;

    let lastState = parsedState;
    try {
      lastState = await EmbroideryTemplateCart.removeAddonLinesByIndex(
        { items },
        linesToRemove,
        sectionsToRender
      );
    } catch (error) {
      console.error(error);
      return null;
    }

    const refreshedCart = await EmbroideryTemplateCart.fetchFullCart();
    const stateForUi = EmbroideryTemplateCart.mergeCartState(lastState, refreshedCart);
    await publish(PUB_SUB_EVENTS.cartUpdate, {
      source: 'embroidery-template-addon',
      cartData: stateForUi,
    });
    return stateForUi;
  }

  static pendingAddonFromPicker(picker) {
    if (!picker) return null;
    const input = picker.getSelectedInput?.();
    if (!input) return null;
    return {
      variantId: input.dataset.addonVariantId,
      parentProductId: picker.parentProductId,
    };
  }

  static installFormHooks() {
    if (EmbroideryTemplateCart._hooksInstalled) return;
    EmbroideryTemplateCart._hooksInstalled = true;

    document.addEventListener(
      'submit',
      (event) => {
        const productForm = event.target.closest?.('product-form');
        if (!productForm) return;
        const sectionId = productForm.dataset.sectionId;
        const picker = sectionId
          ? document.querySelector(`embroidery-template-picker[data-section-id="${CSS.escape(sectionId)}"]`)
          : null;
        productForm._embroideryPendingAddon = EmbroideryTemplateCart.pendingAddonFromPicker(picker);
        productForm._embroideryAwaitingCartUpdate = true;
      },
      true
    );

    subscribe(PUB_SUB_EVENTS.cartUpdate, async (data) => {
      if (data?.source !== 'product-form') return;

      const productForms = [...document.querySelectorAll('product-form')].filter(
        (form) => form._embroideryAwaitingCartUpdate
      );
      if (productForms.length === 0) return;

      await Promise.all(
        productForms.map(async (productForm) => {
          productForm._embroideryAwaitingCartUpdate = false;
          const pending = productForm._embroideryPendingAddon;
          delete productForm._embroideryPendingAddon;
          if (!pending?.variantId) return;
          try {
            await EmbroideryTemplateCart.addAddonVariant(pending);
          } catch (error) {
            console.error(error);
          }
        })
      );
    });

    subscribe(PUB_SUB_EVENTS.cartError, (data) => {
      if (data?.source !== 'product-form') return;
      document.querySelectorAll('product-form').forEach((productForm) => {
        productForm._embroideryAwaitingCartUpdate = false;
        delete productForm._embroideryPendingAddon;
      });
    });
  }
}

window.EmbroideryTemplateCart = EmbroideryTemplateCart;
EmbroideryTemplateCart.installFormHooks();

class EmbroideryTemplatePicker extends HTMLElement {
  constructor() {
    super();
    this._selectedAddonVariantId = null;
    this._selectedAddonPrice = 0;
    this._currentVariant = null;
    this._variantChangeUnsubscriber = undefined;
    this._embroideryValuesByLabel = new Map();
    this._designChoiceByAddonProductId = new Map();
  }

  connectedCallback() {
    if (this._initialized) return;
    this._initialized = true;

    this.sectionId = this.dataset.sectionId;
    this.parentProductId = String(this.dataset.parentProductId || '');
    this.templateProductIds = new Set(
      (this.dataset.templateProductIds || '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean)
    );
    this.currencyCode = this.dataset.currencyCode || 'USD';

    this.addEventListener('change', this.onSelectionChange.bind(this));

    this._variantChangeUnsubscriber = subscribe(PUB_SUB_EVENTS.variantChange, (event) => {
      if (String(event.data?.sectionId) !== String(this.sectionId)) return;
      this._currentVariant = event.data?.variant || null;
      this.updateDisplayedPrice();
    });

    this.bootstrapVariantFromDom();
    this.syncSelectionFromState();
    this.syncEmbroideryTextFieldsVisibility();
    this.syncMiniDesignBlocksVisibility();
    this.updateDisplayedPrice();
  }

  disconnectedCallback() {
    this._variantChangeUnsubscriber?.();
  }

  bootstrapVariantFromDom() {
    const variantSelects = document.getElementById(`variant-selects-${this.sectionId}`);
    this._currentVariant = this.parseJsonScript(variantSelects, '[data-selected-variant]');
  }

  parseJsonScript(parent, selector) {
    try {
      return JSON.parse(parent?.querySelector(selector)?.textContent || 'null');
    } catch {
      return null;
    }
  }

  getSelectedInput() {
    return this.querySelector('input[type="radio"]:checked:not(:disabled)');
  }

  getSelectedAddonPrice() {
    const input = this.getSelectedInput();
    if (!input) return 0;
    return parseInt(input.dataset.addonPrice, 10) || 0;
  }

  syncSelectionFromState() {
    const input = this.getSelectedInput();
    if (!input) {
      this._selectedAddonVariantId = null;
      this._selectedAddonPrice = 0;
      return;
    }
    this._selectedAddonVariantId = input.dataset.addonVariantId;
    this._selectedAddonPrice = parseInt(input.dataset.addonPrice, 10) || 0;
  }

  captureEmbroideryValuesFromBlock(block) {
    if (!block) return;
    block.querySelectorAll('[data-embroidery-text-input]').forEach((input) => {
      const key = input.getAttribute('data-line-item-property');
      if (key) this._embroideryValuesByLabel.set(key, input.value);
    });
  }

  applyEmbroideryValuesToBlock(block) {
    if (!block) return;
    block.querySelectorAll('[data-embroidery-text-input]').forEach((input) => {
      const key = input.getAttribute('data-line-item-property');
      if (key && this._embroideryValuesByLabel.has(key)) {
        input.value = this._embroideryValuesByLabel.get(key);
      }
    });
  }

  setEmbroideryTextBlockInputsEnabled(block, enabled) {
    if (!block) return;
    block.querySelectorAll('[data-embroidery-text-input]').forEach((input) => {
      input.disabled = !enabled;
    });
    block.querySelectorAll('[data-embroidery-text-colour-checkbox]').forEach((checkbox) => {
      checkbox.disabled = !enabled;
    });
    const colourHidden = block.querySelector('[data-embroidery-colour-choice-value]');
    if (colourHidden) colourHidden.disabled = !enabled;
  }

  captureDesignChoiceFromBlock(block) {
    if (!block) return;
    const checked = block.querySelector('input[name="properties[Design]"]:checked');
    const productId = String(block.dataset.addonProductId || '');
    if (!productId) return;
    if (checked) {
      this._designChoiceByAddonProductId.set(productId, checked.value);
    }
  }

  applyDesignChoiceToBlock(block) {
    if (!block) return;
    const productId = String(block.dataset.addonProductId || '');
    if (!productId || !this._designChoiceByAddonProductId.has(productId)) return;
    const value = this._designChoiceByAddonProductId.get(productId);
    block.querySelectorAll('input[name="properties[Design]"]').forEach((input) => {
      input.checked = input.value === value;
    });
  }

  setMiniDesignBlockInputsEnabled(block, enabled) {
    if (!block) return;
    block.querySelectorAll('input[name="properties[Design]"]').forEach((input) => {
      input.disabled = !enabled;
      if (!enabled) {
        input.checked = false;
      }
    });
  }

  syncMiniDesignBlocksVisibility() {
    const picker = this.querySelector('[data-mini-design-template-picker]');
    if (!picker) return;

    const container = picker.querySelector('[data-mini-design-template-blocks-container]');
    if (!container) return;

    const blocks = container.querySelectorAll('[data-mini-design-template-block]');
    const selectedInput = this.getSelectedInput();
    const selectedProductId = selectedInput ? String(selectedInput.dataset.addonProductId || '') : '';

    blocks.forEach((block) => {
      if (!block.classList.contains('hidden')) {
        this.captureDesignChoiceFromBlock(block);
      }
    });

    blocks.forEach((block) => {
      const blockProductId = String(block.dataset.addonProductId || '');
      const isActive = Boolean(selectedProductId) && blockProductId === selectedProductId;
      block.classList.toggle('hidden', !isActive);
      this.setMiniDesignBlockInputsEnabled(block, isActive);
      if (isActive) {
        this.applyDesignChoiceToBlock(block);
      }
    });

    const hasActiveDesignBlock =
      Boolean(selectedProductId) &&
      Boolean(
        container.querySelector(
          `[data-mini-design-template-block][data-addon-product-id="${CSS.escape(selectedProductId)}"]:not(.hidden)`
        )
      );

    picker.classList.toggle('hidden', !hasActiveDesignBlock);
    picker.dataset.hasDesigns = hasActiveDesignBlock ? 'true' : 'false';

    if (!hasActiveDesignBlock) {
      picker.classList.remove('design-selection--invalid');
      const errorEl = picker.querySelector('.design-selection__error');
      errorEl?.classList.add('hidden');
    }
  }

  syncEmbroideryTextFieldsVisibility() {
    const container = this.querySelector('[data-embroidery-template-text-fields-container]');
    if (!container) return;

    const blocks = container.querySelectorAll('[data-embroidery-template-text-fields]');
    const selectedInput = this.getSelectedInput();
    const selectedProductId = selectedInput ? String(selectedInput.dataset.addonProductId || '') : '';

    blocks.forEach((block) => {
      if (!block.classList.contains('hidden')) {
        this.captureEmbroideryValuesFromBlock(block);
      }
    });

    blocks.forEach((block) => {
      const blockProductId = String(block.dataset.addonProductId || '');
      const isActive = Boolean(selectedProductId) && blockProductId === selectedProductId;
      block.classList.toggle('hidden', !isActive);
      this.setEmbroideryTextBlockInputsEnabled(block, isActive);
      if (isActive) {
        this.applyEmbroideryValuesToBlock(block);
      }
    });

    blocks.forEach((block) => {
      if (block.classList.contains('hidden')) return;
      block.querySelectorAll('[data-embroidery-text-input]').forEach((input) => {
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    });
  }

  onSelectionChange(event) {
    const input = event.target;
    if (!input.matches('input[type="radio"]') || input.disabled) return;
    if (!input.dataset.addonVariantId) return;

    this._selectedAddonVariantId = input.dataset.addonVariantId;
    this._selectedAddonPrice = parseInt(input.dataset.addonPrice, 10) || 0;
    this.syncEmbroideryTextFieldsVisibility();
    this.syncMiniDesignBlocksVisibility();
    this.updateDisplayedPrice();
  }

  formatMoney(cents) {
    const amount = cents / 100;
    try {
      return new Intl.NumberFormat(document.documentElement.lang || undefined, {
        style: 'currency',
        currency: this.currencyCode,
      }).format(amount);
    } catch {
      return amount.toFixed(2);
    }
  }

  updateDisplayedPrice() {
    const priceRoot = document.getElementById(`price-${this.sectionId}`);
    const variant = this._currentVariant;
    if (!priceRoot || !variant) return;

    const addonCents = this.getSelectedAddonPrice();
    const basePrice = variant.price;
    const compareAt = variant.compare_at_price;
    const onSale = compareAt && compareAt > basePrice;

    const totalPrice = basePrice + addonCents;
    const totalCompare = onSale ? compareAt + addonCents : null;

    const priceContainer = priceRoot.querySelector('.price') || priceRoot;
    priceContainer.classList.toggle('price--on-sale', Boolean(onSale));

    if (onSale) {
      priceContainer.querySelectorAll('.price__sale .price-item--regular').forEach((el) => {
        el.textContent = this.formatMoney(totalCompare);
      });
      priceContainer.querySelectorAll('.price-item--sale').forEach((el) => {
        el.textContent = this.formatMoney(totalPrice);
      });
    } else {
      priceContainer.querySelectorAll('.price__regular .price-item--regular').forEach((el) => {
        el.textContent = this.formatMoney(totalPrice);
      });
    }
  }
}

if (!customElements.get('embroidery-template-picker')) {
  customElements.define('embroidery-template-picker', EmbroideryTemplatePicker);
}
