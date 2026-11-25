const MAX_CANDIDATES = 1000;
const MAX_DOM_NODES = 50000;
const INTERACTIVE_ROLES = new Set([
  'button', 'checkbox', 'combobox', 'link', 'listbox', 'menuitem',
  'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'scrollbar',
  'searchbox', 'slider', 'spinbutton', 'switch', 'tab', 'textbox', 'treeitem',
]);

function bounded(promise, description, milliseconds = 10000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${description} exceeded ${milliseconds}ms`)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

function axEvidence(nodes, backendId) {
  const node = nodes.find((item) => item.backendDOMNodeId === backendId);
  if (!node) return { role: null, name: null, axStatus: 'unavailable' };
  return {
    role: node.role?.value ?? null,
    name: node.name?.value ?? null,
    axStatus: node.ignored ? 'ignored' : 'exposed',
  };
}

async function prepare(page, marker) {
  return bounded(page.evaluate(({ marker, max, roles }) => {
    const path = (element) => {
      const parts = [];
      for (let current = element; current?.nodeType === Node.ELEMENT_NODE; current = current.parentElement) {
        let index = 1;
        for (let previous = current.previousElementSibling; previous; previous = previous.previousElementSibling) {
          if (previous.localName === current.localName) index++;
        }
        parts.unshift(`${current.localName}:nth-of-type(${index})`);
      }
      return parts.join(' > ');
    };
    const selector = 'button,input,select,textarea,a[href],summary,[tabindex],[contenteditable],[role],[onclick]';
    const eligible = Array.from(document.querySelectorAll(selector)).filter((element) => {
      if (element.getRootNode() !== document || element.matches(':disabled') || element.closest('[inert],[hidden]')) return false;
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return false;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0 || element.matches('input[type="hidden"]')) return false;
      const role = (element.getAttribute('role') || '').toLowerCase().split(/\s+/);
      return element.matches('button,input,select,textarea,a[href],summary,[tabindex],[onclick]') ||
        element.isContentEditable || role.some((value) => roles.includes(value));
    });
    // Native modal dialogs make the rest of the document implicitly inert even
    // when those background elements have no explicit inert attribute.
    const activeNativeModal = document.activeElement?.closest('dialog:modal') ||
      Array.from(document.querySelectorAll('dialog:modal')).at(-1) || null;
    const selected = eligible.slice(0, max);
    const candidates = selected.map((element, index) => {
      const probeId = `candidate-${index}`;
      element.setAttribute(marker, probeId);
      let tabEligible = element.tabIndex >= 0;
      // Native radio groups have one Tab stop, even though all expose tabIndex=0.
      if (element.matches('input[type="radio"]') && element.name) {
        const group = eligible.filter((other) => other.matches('input[type="radio"]') &&
          other.name === element.name && other.form === element.form);
        tabEligible = tabEligible && (group.find((other) => other.checked) || group[0]) === element;
      }
      return {
        id: path(element), probeId, domId: element.id || null,
        tag: element.localName, tabIndex: element.tabIndex, tabEligible,
        nativeModalInert: Boolean(activeNativeModal && !activeNativeModal.contains(element)),
      };
    });
    const allElements = document.querySelectorAll('*');
    return {
      candidates, candidateTotal: eligible.length,
      frames: document.querySelectorAll('iframe,frame').length,
      openShadowHosts: Array.from(allElements).filter((element) => element.shadowRoot).length,
    };
  }, { marker, max: MAX_CANDIDATES, roles: [...INTERACTIVE_ROLES] }), 'candidate discovery');
}

async function resetFocus(page) {
  await bounded(page.evaluate(() => {
    const body = document.body;
    if (!body) throw new Error('The document has no body to begin keyboard sampling');
    const previous = body.getAttribute('tabindex');
    body.setAttribute('tabindex', '-1');
    body.focus({ preventScroll: true });
    if (previous === null) body.removeAttribute('tabindex');
    else body.setAttribute('tabindex', previous);
  }), 'body focus reset');
}

function backendMap(root, marker) {
  const result = new Map();
  const pending = [root];
  let seen = 0;
  while (pending.length && seen < MAX_DOM_NODES) {
    const node = pending.pop();
    seen++;
    const attributes = node.attributes || [];
    for (let index = 0; index + 1 < attributes.length; index += 2) {
      if (attributes[index] === marker) result.set(attributes[index + 1], node.backendNodeId);
    }
    pending.push(...(node.children || []));
  }
  return { map: result, truncated: pending.length > 0, seen };
}

async function focusEvidence(page, session, documentId, marker, backends, sequence) {
  const focus = await bounded(page.evaluate(({ marker, sequence }) => {
    const element = document.activeElement;
    if (!element) return { id: null, tag: null, domId: null, probeId: null };
    const parts = [];
    for (let current = element; current?.nodeType === Node.ELEMENT_NODE; current = current.parentElement) {
      let index = 1;
      for (let previous = current.previousElementSibling; previous; previous = previous.previousElementSibling) {
        if (previous.localName === current.localName) index++;
      }
      parts.unshift(`${current.localName}:nth-of-type(${index})`);
    }
    if (!element.hasAttribute(marker)) element.setAttribute(marker, `focus-${sequence}`);
    return {
      id: parts.join(' > '), tag: element.localName, domId: element.id || null,
      probeId: element.getAttribute(marker),
      nestedFocus: Boolean(element.shadowRoot?.activeElement) || element.matches('iframe,frame'),
      openNativeModals: document.querySelectorAll('dialog:modal').length,
    };
  }, { marker, sequence }), 'active element sampling');
  let backend = backends.get(focus.probeId);
  if (!backend && focus.probeId) {
    const { nodeId } = await bounded(session.send('DOM.querySelector', {
      nodeId: documentId, selector: `[${marker}="${focus.probeId}"]`,
    }), 'active element lookup');
    if (nodeId) {
      const { node } = await bounded(session.send('DOM.describeNode', { nodeId }), 'active DOM evidence');
      backend = node.backendNodeId;
      backends.set(focus.probeId, backend);
    }
  }
  let evidence = { role: null, name: null, axStatus: 'unavailable' };
  if (backend) {
    try {
      const { nodes } = await bounded(session.send('Accessibility.getPartialAXTree', {
        backendNodeId: backend, fetchRelatives: false,
      }), 'active accessibility evidence');
      evidence = axEvidence(nodes, backend);
    } catch {
      // A page can remove a node between focus discovery and the AX query.
    }
  }
  const simulatedAnnouncement = evidence.axStatus === 'ignored'
    ? 'Not exposed in this Chromium accessibility snapshot'
    : evidence.axStatus === 'unavailable'
      ? 'Accessibility role and name unavailable'
      : `${evidence.role || '(unknown role)'}: ${evidence.name?.trim() ? evidence.name : '(unnamed)'}`;
  return { ...focus, ...evidence, simulatedAnnouncement };
}

function repeatingTail(trace, candidates) {
  const eligible = new Map(candidates.filter((candidate) => candidate.tabEligible).map((candidate) => [candidate.id, candidate]));
  for (let period = 1; period <= Math.floor(trace.length / 3); period++) {
    const suffix = trace.slice(-period * 3);
    if (!suffix.every((step, index) => step.id && !step.nestedFocus && eligible.has(step.id) && step.id === suffix[index % period].id)) continue;
    const subset = [...new Set(suffix.map((step) => step.id))];
    const outside = [...eligible.keys()].filter((id) => !subset.includes(id));
    if (outside.length) return { period, repetitions: 3, subset, outside };
  }
  return null;
}

async function samplePass(page, session, marker, direction, options) {
  await bounded(page.reload({ waitUntil: 'domcontentloaded', timeout: 10000 }), 'independent pass reload');
  if (options.settleMs) await page.waitForTimeout(options.settleMs);
  const prepared = await prepare(page, marker);
  const { root } = await bounded(session.send('DOM.getDocument', { depth: -1, pierce: false }), 'DOM tree');
  const mapping = backendMap(root, marker);
  const { nodes } = await bounded(session.send('Accessibility.getFullAXTree'), 'accessibility tree');
  for (const candidate of prepared.candidates) {
    Object.assign(candidate, axEvidence(nodes, mapping.map.get(candidate.probeId)));
  }
  await resetFocus(page);
  const trace = [];
  const key = direction === 'forward' ? 'Tab' : 'Shift+Tab';
  for (let step = 1; step <= options.steps; step++) {
    await bounded(page.keyboard.press(key), 'keyboard focus step');
    if (options.settleMs) await page.waitForTimeout(options.settleMs);
    trace.push({ step, ...await focusEvidence(page, session, root.nodeId, marker, mapping.map, `${direction}-${step}`) });
  }
  const cycle = repeatingTail(trace, prepared.candidates);
  let escapeProbe = null;
  if (cycle) {
    const before = trace.at(-1);
    await bounded(page.keyboard.press('Escape'), 'Escape recovery probe');
    // Native dialog cancellation and focus restoration are queued browser work.
    // Yield a render frame and browser task even for zero-delay traversal.
    await bounded(page.evaluate(() => new Promise((resolve) => {
      requestAnimationFrame(() => setTimeout(resolve, 0));
    })), 'Escape browser recovery', 1000);
    if (options.settleMs) await page.waitForTimeout(options.settleMs);
    const afterEscape = await focusEvidence(page, session, root.nodeId, marker, mapping.map, `${direction}-escape`);
    await bounded(page.keyboard.press('Tab'), 'Tab recovery probe');
    if (options.settleMs) await page.waitForTimeout(options.settleMs);
    const afterTab = await focusEvidence(page, session, root.nodeId, marker, mapping.map, `${direction}-escape-tab`);
    const reachedOutside = cycle.outside.includes(afterEscape.id) || cycle.outside.includes(afterTab.id);
    const dismissedNativeModal = before.openNativeModals > afterEscape.openNativeModals;
    const recovered = reachedOutside || dismissedNativeModal;
    const recoveryReason = reachedOutside ? 'outside-control-reached'
      : dismissedNativeModal ? 'native-modal-dismissed' : 'no-observed-recovery';
    escapeProbe = {
      direction, cycle, before, afterEscape, afterTab, recovered, recoveryReason,
      recoveryYield: 'animation-frame-and-task',
    };
  }
  return {
    ...prepared, trace, escapeProbe, axNodeCount: nodes.length,
    domNodesExamined: mapping.seen, domMappingTruncated: mapping.truncated,
  };
}

/**
 * Audit one already-selected Chromium page using real keyboard focus changes.
 * Each direction reloads and reexecutes page scripts. Only top-level light DOM
 * is covered; this is an accessibility-tree probe, not a screen-reader test.
 */
export async function audit(page, { steps = 30, settleMs = 20 } = {}) {
  if (!Number.isInteger(steps) || steps < 1 || steps > 200) throw new RangeError('steps must be an integer from 1 to 200');
  if (!Number.isInteger(settleMs) || settleMs < 0 || settleMs > 1000) throw new RangeError('settleMs must be an integer from 0 to 1000');
  const marker = `data-keyboard-audit-${Math.random().toString(36).slice(2)}`;
  const session = await page.context().newCDPSession(page);
  const options = { steps, settleMs };
  const warnings = [];
  const passes = {};
  try {
    await bounded(session.send('Accessibility.enable'), 'accessibility initialization');
    passes.forward = await samplePass(page, session, marker, 'forward', options);
    passes.reverse = await samplePass(page, session, marker, 'reverse', options);
    const candidates = new Map();
    for (const direction of ['forward', 'reverse']) {
      for (const candidate of passes[direction].candidates) {
        const previous = candidates.get(candidate.id);
        candidates.set(candidate.id, {
          ...candidate,
          nativeModalInert: previous ? previous.nativeModalInert && candidate.nativeModalInert : candidate.nativeModalInert,
          observedIn: [...(previous?.observedIn || []), direction],
        });
      }
    }
    const reached = new Set([...passes.forward.trace, ...passes.reverse.trace].map((step) => step.id));
    const findings = [];
    for (const candidate of candidates.values()) {
      if (candidate.axStatus === 'exposed' && INTERACTIVE_ROLES.has(candidate.role) && !(candidate.name || '').trim()) {
        findings.push({
          type: 'unlabeled-control', id: candidate.id,
          message: 'Chromium exposes an interactive control with an empty accessible name.',
          evidence: candidate,
        });
      }
      if (!reached.has(candidate.id) && !candidate.nativeModalInert) {
        findings.push({
          type: 'unreached-control', id: candidate.id,
          message: 'A visible potentially interactive candidate was not reached in either bounded keyboard direction. Intentional composite-widget focus targets may need manual review.',
          evidence: { ...candidate, sampledStepsPerDirection: steps },
        });
      }
    }
    const trapFindings = new Map();
    for (const direction of ['forward', 'reverse']) {
      const probe = passes[direction].escapeProbe;
      if (!probe || probe.recovered) continue;
      const key = [...probe.cycle.subset].sort().join('\n');
      const previous = trapFindings.get(key);
      if (previous) previous.evidence.probes.push(probe);
      else trapFindings.set(key, {
        type: 'suspected-focus-trap',
        message: 'Keyboard focus repeated a strict subset three times while other tab-eligible controls existed; Escape followed by Tab did not reach those outside controls. Confirm the intended widget or modal behavior manually.',
        evidence: { probes: [probe] },
      });
    }
    findings.push(...trapFindings.values());
    const changed = [...candidates.values()].some((candidate) => candidate.observedIn.length !== 2);
    const nativeModalInertCandidateCount = [...candidates.values()].filter((candidate) => candidate.nativeModalInert).length;
    if (nativeModalInertCandidateCount) warnings.push(`${nativeModalInertCandidateCount} background candidates were excluded from unreached-control findings because a native modal made them inert in every observed pass. They remain in trap and recovery evidence.`);
    if (changed) warnings.push('Candidate paths changed between reloads; comparisons may refer to different page states.');
    if (Object.values(passes).some((pass) => pass.candidateTotal > MAX_CANDIDATES)) warnings.push(`Candidate coverage was capped at ${MAX_CANDIDATES} per direction.`);
    if (Object.values(passes).some((pass) => pass.domMappingTruncated)) warnings.push(`DOM-to-accessibility mapping stopped after ${MAX_DOM_NODES} nodes.`);
    if (Object.values(passes).some((pass) => pass.frames || pass.openShadowHosts)) warnings.push('Frames or open shadow roots were detected. Their internal keyboard paths and controls are outside this audit scope.');
    if ([...candidates.values()].some((candidate) => candidate.axStatus === 'unavailable')) warnings.push('Some candidates lacked matching Chromium accessibility nodes; their accessible names remain unknown.');
    return {
      version: 1, url: page.url(), options,
      scope: {
        topLevelLightDomOnly: true, actualScreenReader: false, simulatedAnnouncement: true,
        announcementSource: 'Plain Chromium AX role/name summaries, not actual assistive-technology speech or behavior.',
        reloadsPage: true, actions: ['Tab', 'Shift+Tab', 'Escape recovery probe'],
        limitation: 'Bounded evidence only; no accessibility-conformance or complete keyboard-reachability claim. Closed shadow roots, browser chrome, cross-frame focus and application-specific arrow-key navigation are not covered.',
      },
      coverage: {
        candidateCount: candidates.size, candidateLimitPerDirection: MAX_CANDIDATES,
        forwardCandidateTotal: passes.forward.candidateTotal, reverseCandidateTotal: passes.reverse.candidateTotal,
        axNodes: { forward: passes.forward.axNodeCount, reverse: passes.reverse.axNodeCount },
        sampledSteps: { forward: passes.forward.trace.length, reverse: passes.reverse.trace.length },
        reachedCandidateCount: [...candidates.keys()].filter((id) => reached.has(id)).length,
        nativeModalInertCandidateCount,
        bounded: true,
      },
      traces: { forward: passes.forward.trace, reverse: passes.reverse.trace },
      escapeProbes: Object.values(passes).map((pass) => pass.escapeProbe).filter(Boolean),
      findings, warnings,
    };
  } finally {
    try {
      await bounded(page.evaluate((marker) => {
        for (const element of document.querySelectorAll(`[${marker}]`)) element.removeAttribute(marker);
      }, marker), 'probe cleanup', 1000);
    } catch { /* A navigation or closed page can prevent cleanup. */ }
    await session.detach().catch(() => {});
  }
}
