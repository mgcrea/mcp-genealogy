// The shared shape every tool answers in, whatever the source (spec: "The shared shape").
// Compact JSON: optional fields are omitted when empty, never sent as null or "".

export type Ref = {
  source: "geneanet" | "matchid" | "geni" | "familysearch";
  id: string;
  url: string;
};
// geneanet id: "<tree>:<index>", or "<tree>:<n>/<p>/<oc>" for a search hit with no index yet;
// matchid id: its `id`; geni: "profile-<n>".

export type DateValue = {
  date?: string; // ISO, as precise as known: "1897-04-03", "1897-04", "1897"
  qualifier?: "about" | "maybe" | "before" | "after" | "between" | "or" | "from" | "to";
  dateTo?: string; // second bound for between / or / from–to
  calendar?: "julian" | "french" | "hebrew"; // omitted = gregorian; date stays in that calendar
  text?: string; // the source's own wording, only when it could not be parsed
};

export type Place = {
  name: string; // as the source wrote the locality, e.g. "Beauvais-sur-Tescou"
  insee?: string; // 5 chars: \d{5} or 2[AB]\d{3}, only from a source known to give INSEE codes
  code?: string; // a 5-character commune code as the source wrote it, postal or INSEE unknown
  department?: string; // name or code, as given
  region?: string;
  country?: string;
  raw?: string; // full original string when it was split
};

export type Citation = {
  source: Ref["source"];
  url?: string;
  title?: string; // e.g. "INSEE, fichier des personnes décédées, 1978"
  text?: string; // free text, verbatim (tree owners' sources)
  acte?: string; // only from structured fields (matchID certificateId)
  page?: string; // only from structured fields
};

export type Event = {
  type: "birth" | "baptism" | "death" | "burial" | "marriage" | "occupation" | string;
  date?: DateValue;
  place?: Place;
  citations?: Citation[];
  with?: Brief; // spouse for marriage
  // `full` detail only (Geneanet): the tree owner's note on the event, and its witnesses.
  note?: string;
  witnesses?: (Brief & { role: string; note?: string })[];
};

/** A person as a link from another record: enough to recognise them, and their ref to fetch more. */
export type Brief = {
  ref: Ref;
  name: string;
  sex?: "male" | "female"; // tells father from mother when only one parent is known
  born?: string; // ISO-or-qualified short form: "1897-04-03", "about 1768"
  bornAt?: string;
  died?: string;
  diedAt?: string;
  withheld?: Withheld;
};

export type Withheld =
  | "private" // the source flagged the person hidden
  | "probably-private" // inferred: empty record, alive or unknown death status
  | "premium"; // Geneanet archive detail masked as XXXX

export type Person = {
  ref: Ref;
  name: string;
  given?: string;
  surname?: string;
  sex?: "male" | "female";
  aliases?: string[];
  occupation?: string;
  events: Event[];
  parents?: Brief[];
  // `full` carries `children`; `summary` carries `childCount` only.
  families?: { spouse?: Brief; events: Event[]; children?: Brief[]; childCount?: number }[];
  notes?: string;
  withheld?: Withheld;
  withheldReason?: string;
  // Geneanet extras.
  tree?: string;
  index?: number;
  treeRoot?: true;
  directAncestorOfTreeRoot?: true;
  eventsTruncated?: string;
  deathStatus?: string;
  /** How much of the record this is. */
  detail: "summary" | "full";
};
