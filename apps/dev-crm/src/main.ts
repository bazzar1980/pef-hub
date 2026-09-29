import type {
  CallLogPayload,
  ContactResult,
  InteractionUpdatePayload,
  PefInteraction,
  ScreenPopPayload,
  Snapshot,
} from '@pef-hub/protocol';

declare const __CRM_PROFILE__: 'fake' | 'mystery';

// Mirrors PefHubCrmApi in packages/sdk-extension/src/generic-adapter.ts (the page must not depend on the SDK).
declare global {
  interface Window {
    pefHubCrm?: {
      screenPop?(p: ScreenPopPayload): void | Promise<void>;
      searchContacts?(searchString: string): ContactResult[] | Promise<ContactResult[]>;
      logCall?(p: CallLogPayload): void | Promise<void>;
      onSnapshot?(s: Snapshot): void;
    };
  }
}

interface Profile {
  name: string;
  accent: string;
  contacts: ContactResult[];
}

const PROFILES: Record<typeof __CRM_PROFILE__, Profile> = {
  fake: {
    name: 'Fake CRM',
    accent: '#ff4f1f',
    contacts: [
      { type: 'external', name: 'Mario Rossi', phone: [{ number: '+390755551234', label: 'Mobile' }] },
      { type: 'external', name: 'Giulia Bianchi', phone: [{ number: '+390755559876', label: 'Office' }] },
    ],
  },
  mystery: {
    name: 'Mystery CRM',
    accent: '#5b3cc4',
    contacts: [
      { type: 'external', name: 'Luca Verdi', phone: [{ number: '+390266661111', label: 'Mobile' }] },
      { type: 'external', name: 'Anna Neri', phone: [{ number: '+390266662222', label: 'Office' }] },
    ],
  },
};

const profile = PROFILES[__CRM_PROFILE__];
const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

document.title = profile.name;
$('#title').textContent = profile.name;
document.documentElement.style.setProperty('--accent', profile.accent);

// ---- Contacts (tel: links are picked up by the generic adapter's click-to-dial) ----
$('#contacts tbody').innerHTML = profile.contacts
  .map((c) => {
    const phones = (c.phone ?? []).map((p) => `<a href="tel:${p.number}">${p.number}</a> <small>${p.label ?? ''}</small>`);
    return `<tr><td>${c.name}</td><td>${phones.join('<br>')}</td></tr>`;
  })
  .join('');

// ---- Event log ----
function log(type: string, detail?: unknown): void {
  const li = document.createElement('li');
  const time = new Date().toLocaleTimeString();
  li.innerHTML = `${time} <span class="type"></span> `;
  li.querySelector('.type')!.textContent = type;
  if (detail !== undefined) li.append(JSON.stringify(detail));
  $('#log').prepend(li);
}
$('#clear').addEventListener('click', () => ($('#log').innerHTML = ''));

// ---- Interactions table ----
const interactions = new Map<string, { interaction: PefInteraction; ownerCrm?: string | null }>();
function renderInteractions(): void {
  $('#interactions tbody').innerHTML = [...interactions.values()]
    .map(
      ({ interaction: i, ownerCrm }) =>
        `<tr><td>${i.id.slice(0, 8)}</td><td>${i.ani ?? ''}</td><td>${i.queueName ?? ''}</td><td>${i.state ?? ''}</td><td>${ownerCrm ?? ''}</td></tr>`,
    )
    .join('');
}

function showRecord(p: ScreenPopPayload): void {
  const ani = p.interaction?.ani ?? p.searchString ?? '';
  const needle = ani.replace(/\D/g, '');
  const match = profile.contacts.find((c) => c.phone?.some((ph) => needle && ph.number.replace(/\D/g, '').endsWith(needle.slice(-9))));
  const card = $('#record');
  card.classList.remove('empty');
  card.innerHTML = '';
  const lines = [
    `Contact: ${match?.name ?? 'Unknown caller'}`,
    `ANI: ${ani}`,
    `Queue: ${p.interaction?.queueName ?? '-'}`,
    `Interaction: ${p.interaction?.id ?? '-'}`,
  ];
  for (const l of lines) card.append(l, document.createElement('br'));
}

// ---- Page contract consumed by the generic adapter (MAIN world) ----
window.pefHubCrm = {
  screenPop: (p: ScreenPopPayload) => showRecord(p),
  searchContacts: (q: string) => {
    const needle = q.replace(/\s/g, '').toLowerCase();
    const results = profile.contacts.filter(
      (c) => c.name.toLowerCase().includes(needle) || c.phone?.some((p) => p.number.includes(needle)),
    );
    log('contactSearch', { q, results: results.length });
    return results;
  },
  logCall: () => {},
  onSnapshot: (s: Snapshot) => {
    interactions.clear();
    for (const i of s.interactions) interactions.set(i.id, { interaction: i.interaction, ownerCrm: i.ownerCrm });
    renderInteractions();
  },
};

// DOM events emitted by the generic adapter
addEventListener('pefhub:screenpop', (e) => log('screenPop', (e as CustomEvent<ScreenPopPayload>).detail));
addEventListener('pefhub:calllog', (e) => log('processCallLog', (e as CustomEvent<CallLogPayload>).detail));
addEventListener('pefhub:snapshot', (e) => log('snapshot', (e as CustomEvent<Snapshot>).detail));
addEventListener('pefhub:interaction', (e) => {
  const p = (e as CustomEvent<InteractionUpdatePayload>).detail;
  log(`interaction:${p.category}`, { id: p.interaction?.id, state: p.interaction?.state });
  if (p.interaction?.id) {
    const prev = interactions.get(p.interaction.id);
    interactions.set(p.interaction.id, { interaction: p.interaction, ownerCrm: prev?.ownerCrm });
    renderInteractions();
  }
});
document.addEventListener('click', (e) => {
  const a = (e.target as Element | null)?.closest?.('a[href^="tel:"]');
  if (a) log('clickToDial (sent by extension)', a.getAttribute('href')!.slice(4));
});

log('page ready', { crm: profile.name, origin: location.origin });
