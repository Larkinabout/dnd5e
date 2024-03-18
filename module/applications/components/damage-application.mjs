/**
 * List of multiplier options as tuples containing their numeric value and rendered text.
 * @type {[number, string][]}
 */
const MULTIPLIERS = [[-1, "-1"], [0, "0"], [.25, "¼"], [.5, "½"], [1, "1"], [2, "2"]];

/**
 * Application to handle applying damage from a chat card.
 */
export default class DamageApplicationElement extends HTMLElement {

  /* -------------------------------------------- */
  /*  Properties                                  */
  /* -------------------------------------------- */

  /**
   * The apply damage button within the element.
   * @type {HTMLButtonElement}
   */
  applyButton;

  /* -------------------------------------------- */

  /**
   * The chat message with which this damage is associated.
   * @type {ChatMessage5e}
   */
  chatMessage;

  /* -------------------------------------------- */

  /**
   * Damage descriptions that will be applied by this application.
   * @type {DamageDescription[]}
   */
  damages = [];

  /* -------------------------------------------- */

  /**
   * Currently registered hook for monitoring for changes to selected tokens.
   * @type {number|null}
   */
  selectedTokensHook = null;

  /* -------------------------------------------- */

  /**
   * Currently target selection mode.
   * @type {"targeted"|"selected"}
   */
  get targetingMode() {
    if ( !game.user.isGM ) return "targeted";
    return this.querySelector('.target-source-control [aria-pressed="true"]')?.dataset.mode ?? "targeted";
  }

  set targetingMode(mode) {
    const toPress = this.querySelector(`.target-source-control [data-mode="${mode}"]`);
    if ( toPress?.ariaPressed === "true" ) return;
    const currentlyPressed = this.querySelector('.target-source-control [aria-pressed="true"]');
    if ( currentlyPressed ) currentlyPressed.ariaPressed = false;
    toPress.ariaPressed = true;
    this.buildTargetsList();
  }

  /* -------------------------------------------- */

  /**
   * The list of application targets.
   * @type {HTMLUListElement}
   */
  targetList;

  /* -------------------------------------------- */

  /**
   * Options for each application target.
   * @type {Map<string, DamageApplicationOptions>}
   */
  #targetOptions = new Map();

  /**
   * Options for a specific target.
   * @param {string} uuid  UUID of the targeted token.
   * @returns {DamageApplicationOptions}
   */
  targetOptions(uuid) {
    if ( !this.#targetOptions.has(uuid) ) this.#targetOptions.set(uuid, { multiplier: 1 });
    return this.#targetOptions.get(uuid);
  }

  /* -------------------------------------------- */
  /*  Rendering                                   */
  /* -------------------------------------------- */

  async connectedCallback() {
    // Fetch the associated chat message
    const messageId = this.closest("[data-message-id]")?.dataset.messageId;
    this.chatMessage = game.messages.get(messageId);
    if ( !this.chatMessage ) return;

    // Build the frame HTML only once
    if ( !this.targetList ) {
      const div = document.createElement("div");
      div.classList.add("card-tray", "damage-tray", "collapsible");
      div.innerHTML = `
        <label class="roboto-upper">
          <i class="fa-solid fa-heart-crack"></i>
          <span>${game.i18n.localize("DND5E.Apply")}</span>
          <i class="fa-solid fa-caret-down"></i>
        </label>
        <div class="collapsible-content">
          <div class="target-source-control">
            <button type="button" class="unbutton" data-mode="targeted" aria-pressed="true">
              <i class="fa-solid fa-bullseye" inert></i> ${game.i18n.localize("DND5E.Tokens.Targeted")}
            </button>
            <button type="button" class="unbutton" data-mode="selected" aria-pressed="false">
              <i class="fa-solid fa-expand inert"></i> ${game.i18n.localize("DND5E.Tokens.Selected")}
            </button>
          </div>
          <ul class="targets unlist"></ul>
          <button class="apply-damage" type="button" data-action="applyDamage">
            <i class="fa-solid fa-reply-all fa-flip-horizontal inert"></i>
            ${game.i18n.localize("DND5E.Apply")}
          </button>
        </div>
      `;
      this.replaceChildren(div);
      this.applyButton = div.querySelector(".apply-damage");
      this.applyButton.addEventListener("click", this._onApplyDamage.bind(this));
      this.targetList = div.querySelector(".targets");
      div.querySelectorAll(".target-source-control button").forEach(b =>
        b.addEventListener("click", this._onChangeTargetMode.bind(this))
      );
      div.querySelector(".collapsible-content").addEventListener("click", event => {
        event.stopImmediatePropagation();
      });
    }

    this.buildTargetsList();
  }

  /* -------------------------------------------- */

  /**
   * Build a list of targeted tokens based on current mode & replace any existing targets.
   */
  async buildTargetsList() {
    // Ensure collapsible section automatically resizes when content changes
    const collapsible = this.querySelector(".collapsible-content");
    if ( collapsible.style.height !== "0px" ) collapsible.style.height = "auto";

    let targetedTokens;
    switch ( this.targetingMode ) {
      case "targeted":
        targetedTokens = (this.chatMessage.getFlag("dnd5e", "targets") ?? []).map(t => t.uuid);
        if ( this.selectedTokensHook ) {
          Hooks.off("controlToken", this.selectedTokensHook);
          this.selectedTokensHook = null;
        }
        break;
      case "selected":
        targetedTokens = canvas.tokens.controlled.map(t => t.document.actor.uuid);
        this.selectedTokensHook ??= Hooks.on("controlToken", foundry.utils.debounce(() => this.buildTargetsList(), 50));
        break;
    }
    const targets = await Promise.all(targetedTokens.map(t => this.buildTargetListEntry(t)));
    this.targetList.replaceChildren(...targets.filter(e => e));

    // Reset collapsible height to allow for animation
    requestAnimationFrame(() => {
      const height = collapsible.getBoundingClientRect().height;
      collapsible.style.height = `${height}px`;
    });
  }

  /* -------------------------------------------- */

  /**
   * Create a list entry for a single target.
   * @param {string} uuid  UUID of the token represented by this entry.
   * @returns {HTMLLIElement|void}
   */
  async buildTargetListEntry(uuid) {
    const token = await fromUuid(uuid);
    if ( !token ) return;

    // Calculate damage to apply
    const targetOptions = this.targetOptions(uuid);
    const { total } = this.calculateDamage(token, targetOptions);

    const li = document.createElement("li");
    li.classList.add("target");
    li.dataset.targetUuid = uuid;
    li.innerHTML = `
      <img class="gold-icon" alt="${token.name}" src="${token.img}">
      <div class="name-stacked">
        <span class="title">${token.name}</span>
        <!-- TODO: List resistances, etc. applied -->
      </div>
      <div class="calculated-damage">
        ${total}
      </div>
      <menu class="damage-multipliers unlist"></menu>
    `;

    const menu = li.querySelector("menu");
    for ( const [value, display] of MULTIPLIERS ) {
      const entry = document.createElement("li");
      entry.innerHTML = `
        <button class="multiplier-button" type="button" value="${value}">
          <span>${display}</span>
        </button>
      `;
      menu.append(entry);
    }

    this.refreshListEntry(token, li, targetOptions);
    li.addEventListener("click", this._onChangeOptions.bind(this));

    return li;
  }

  /* -------------------------------------------- */

  /**
   * Calculate the total damage that will be applied to an actor.
   * @param {Actor5e} actor
   * @param {DamageApplicationOptions} options
   * @returns {{total: number, damages: DamageDescription[]}}
   */
  calculateDamage(actor, options) {
    const damages = actor.calculateDamage(this.damages, options);

    let total = damages.reduce((acc, d) => acc + d.value, 0);
    total = total > 0 ? Math.floor(total) : Math.ceil(total);

    return { total, damages };
  }

  /* -------------------------------------------- */

  /**
   * Refresh the damage total on a list entry based on modified options.
   * @param {Actor5e} token
   * @param {HTMLLiElement} entry
   * @param {DamageApplicationOptions} options
   */
  refreshListEntry(token, entry, options) {
    const { total } = this.calculateDamage(token, options);
    entry.querySelector(".calculated-damage").innerText = total;

    const pressedMultiplier = entry.querySelector('.multiplier-button[aria-pressed="true"]');
    if ( Number(pressedMultiplier?.dataset.multiplier) !== options.multiplier ) {
      if ( pressedMultiplier ) pressedMultiplier.ariaPressed = false;
      const toPress = entry.querySelector(`[value="${options.multiplier}"]`);
      if ( toPress ) toPress.ariaPressed = true;
    }
  }

  /* -------------------------------------------- */
  /*  Event Handlers                              */
  /* -------------------------------------------- */

  /**
   * Handle clicking the apply damage button.
   * @param {PointerEvent} event  Triggering click event.
   */
  async _onApplyDamage(event) {
    event.preventDefault();
    for ( const target of this.targetList.querySelectorAll("[data-target-uuid]") ) {
      const token = await fromUuid(target.dataset.targetUuid);
      const options = this.targetOptions(target.dataset.targetUuid);
      await token?.applyDamage(this.damages, options);
    }
    this.querySelector(".collapsible").dispatchEvent(new PointerEvent("click", { bubbles: true, cancelable: true }));
  }

  /* -------------------------------------------- */

  /**
   * Handle clicking a multiplier button or resistance toggle.
   * @param {PointerEvent} event  Triggering click event.
   */
  async _onChangeOptions(event) {
    event.preventDefault();
    const button = event.target.closest("button");
    const uuid = event.target.closest("[data-target-uuid]")?.dataset.targetUuid;
    if ( !uuid || !button ) return;

    const options = this.targetOptions(uuid);

    // Set multiplier
    if ( button.classList.contains("multiplier-button") ) {
      options.multiplier = Number(button.value);
    }

    // TODO: Set imm/res/vul ignore & downgrade

    const token = await fromUuid(uuid);
    const entry = this.targetList.querySelector(`[data-target-uuid="${token.uuid}"]`);
    this.refreshListEntry(token, entry, options);
  }

  /* -------------------------------------------- */

  /**
   * Handle clicking on the target mode buttons.
   * @param {PointerEvent} event  Triggering click event.
   */
  async _onChangeTargetMode(event) {
    event.preventDefault();
    this.targetingMode = event.currentTarget.dataset.mode;
  }
}
