import { useLayoutEffect, useRef, type ReactNode } from "react";
import { ArrowDown, ArrowUp, GripVertical } from "lucide-react";
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent, type Modifier } from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useMotion } from "./motion";
import { glideFlip, snapFlip, softSpringCss, type FlipSnap } from "./flipGlide";

// A short list the user puts in order (Settings → "On hover" / "Not hovered", the card preview orders): drag an item by any
// part of it (the playlist bar's dnd-kit sortable, held to the list's axis), or move it one place with its up / down buttons
// (keyboard: Tab to them, Enter / Space). `endAt`: the item after which nothing is reached; those below it are dimmed.
// Motion on, the items glide to their new places on the soft spring (dragged: dnd-kit's transition; a button: a FLIP);
// motion off they take their places at once and only the dimming fades. Guard: probe-cardpreview cardpv:orderCtl.
export type OrderItem = { id: string; label: string; icon?: ReactNode };

// PERF: one options object for the list's life (useSensor memoizes on it)
const SENSOR_OPTS = { activationConstraint: { distance: 4 } };
// the list only reorders up and down
const vertical: Modifier = ({ transform }) => ({ ...transform, x: 0 });
const MODS = [vertical];

export function OrderList({ items, order, onChange, label, endAt }: {
  items: OrderItem[]; order: string[]; onChange: (order: string[]) => void; label: string; endAt?: string;
}) {
  const motion = useMotion();
  const sensors = useSensors(useSensor(PointerSensor, SENSOR_OPTS));
  const listRef = useRef<HTMLOListElement>(null);
  const flip = useRef<FlipSnap | null>(null);
  // after a button move: the item and the way it went, so focus stays on a usable button of that item
  const moved = useRef<{ id: string; dir: -1 | 1 } | null>(null);
  const end = endAt ? order.indexOf(endAt) : -1;
  const byId = new Map(items.map((x) => [x.id, x]));

  useLayoutEffect(() => {
    glideFlip(flip.current, listRef.current, ":scope > .ord-item");
    flip.current = null;
    const m = moved.current;
    moved.current = null;
    if (!m) return;
    const row = listRef.current?.querySelector(`:scope > [data-ord-id="${m.id}"]`);
    const same = row?.querySelector<HTMLButtonElement>(`[data-ord-move="${m.dir < 0 ? "up" : "down"}"]`);
    const other = row?.querySelector<HTMLButtonElement>(`[data-ord-move="${m.dir < 0 ? "down" : "up"}"]`);
    // the button pressed is disabled at the list's end: focus moves to the other one instead of falling to the page
    if (same?.disabled && document.activeElement !== other) other?.focus();
  }, [order]);

  const move = (id: string, dir: -1 | 1) => {
    const i = order.indexOf(id), j = i + dir;
    if (i < 0 || j < 0 || j >= order.length) return;
    if (motion) flip.current = snapFlip(listRef.current, ":scope > .ord-item");
    moved.current = { id, dir };
    onChange(arrayMove(order, i, j));
  };
  const onDragEnd = (e: DragEndEvent) => {
    const from = order.indexOf(String(e.active.id)), to = e.over ? order.indexOf(String(e.over.id)) : -1;
    if (from >= 0 && to >= 0 && from !== to) onChange(arrayMove(order, from, to));
    // a pointer drop leaves focus on the item: no stray ring on the next key
    (document.activeElement as HTMLElement | null)?.blur?.();
  };

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={MODS} onDragEnd={onDragEnd}>
      <SortableContext items={order} strategy={verticalListSortingStrategy}>
        <ol ref={listRef} className="ord" aria-label={label} data-ord={order.join(",")}>
          {order.map((id, i) => {
            const it = byId.get(id);
            return it && <OrderRow key={id} item={it} index={i} last={i === order.length - 1} unreached={end >= 0 && i > end}
              motion={motion} onMove={move} />;
          })}
        </ol>
      </SortableContext>
    </DndContext>
  );
}

function OrderRow({ item, index, last, unreached, motion, onMove }: {
  item: OrderItem; index: number; last: boolean; unreached: boolean; motion: boolean; onMove: (id: string, dir: -1 | 1) => void;
}) {
  const spring = motion ? softSpringCss() : null;
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
    // motion off: the others take their places at once, and a dropped item lands where it is
    transition: spring ? { duration: spring.ms, easing: spring.e } : null,
    animateLayoutChanges: motion ? undefined : () => false,
  });
  // the buttons are their own controls: a press on one never starts a drag
  const stop = (e: React.PointerEvent) => e.stopPropagation();
  return (
    <li ref={setNodeRef} className={`ord-item${isDragging ? " dragging" : ""}`} data-ord-id={item.id} data-unreached={unreached ? "" : undefined}
      aria-label={`${index + 1}. ${item.label}${unreached ? ", never shown" : ""}`}
      style={{ transform: CSS.Translate.toString(transform), transition: transition ?? undefined }} {...listeners}>
      <GripVertical className="ord-grip" size={14} aria-hidden />
      <span className="ord-n" aria-hidden>{index + 1}</span>
      <span className="ord-label" aria-hidden>{item.icon}{item.label}</span>
      <button type="button" className="ord-mv" data-ord-move="up" aria-label={`Move ${item.label} up`} disabled={index === 0}
        onPointerDown={stop} onClick={() => onMove(item.id, -1)}><ArrowUp size={14} /></button>
      <button type="button" className="ord-mv" data-ord-move="down" aria-label={`Move ${item.label} down`} disabled={last}
        onPointerDown={stop} onClick={() => onMove(item.id, 1)}><ArrowDown size={14} /></button>
    </li>
  );
}
