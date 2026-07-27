import {
  chooseShipmentMatch,
  type MatchableShipment,
  type ShipmentSignals,
} from './shipmentDocumentMatcher.js';

/**
 * Pure create-vs-merge decision for a freshly-parsed document, decoupled from
 * the LLM and the DB so it can be unit-tested directly.
 *
 *   matched (confident)  -> { action: 'merge', refId }  (caller fills EMPTY cells only)
 *   none                 -> { action: 'create' }        (new shipment)
 *   ambiguous            -> { action: 'clarify', ... }  (ask the user via the modal)
 *
 * The `clarify` branch carries a ready-to-render clarification question whose
 * `options` are clickable in the dashboard modal, plus a parallel
 * `commitOptions` array that maps each option label back to the concrete
 * { action, refId } the /parse-commit endpoint needs.
 */
export type IntakeCommitOption =
  | { label: string; action: 'create' }
  | { label: string; action: 'merge'; refId: string };

export type IntakeDecision =
  | { action: 'create' }
  | { action: 'merge'; refId: string; score: number; evidence: string[] }
  | {
      action: 'clarify';
      questions: Array<{ text: string; options: string[] }>;
      commitOptions: IntakeCommitOption[];
    };

/** Human label for a merge candidate button, e.g. "Merge into S00043252 — ABC→XYZ". */
export function candidateLabel(shipment: MatchableShipment): string {
  const parties = [shipment.shipperName, shipment.receiverName]
    .filter((v) => v != null && String(v).trim() !== '')
    .join('→');
  const tail = parties || (shipment.customerName ?? '').trim();
  return tail ? `Merge into ${shipment.refId} — ${tail}` : `Merge into ${shipment.refId}`;
}

export const CREATE_NEW_LABEL = 'Create a new shipment';

export function decideShipmentIntake(
  signals: ShipmentSignals,
  rows: MatchableShipment[]
): IntakeDecision {
  const decision = chooseShipmentMatch(signals, rows);
  if (decision.status === 'matched') {
    return {
      action: 'merge',
      refId: decision.match.shipment.refId,
      score: decision.match.score,
      evidence: decision.match.evidence,
    };
  }
  if (decision.status === 'none') {
    return { action: 'create' };
  }
  // ambiguous — surface a create-or-merge question with clickable options.
  const commitOptions: IntakeCommitOption[] = [
    { label: CREATE_NEW_LABEL, action: 'create' },
    ...decision.ranked.map(
      (item): IntakeCommitOption => ({
        label: candidateLabel(item.shipment),
        action: 'merge',
        refId: item.shipment.refId,
      })
    ),
  ];
  return {
    action: 'clarify',
    questions: [
      {
        text: 'This looks like it might already exist in LoadMode. Create a new shipment, or merge this file into one of these?',
        options: commitOptions.map((o) => o.label),
      },
    ],
    commitOptions,
  };
}
