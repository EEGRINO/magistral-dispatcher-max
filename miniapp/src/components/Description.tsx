/** Описание заявки карточкой: длинный текст (до 4000 символов) переносится, а не обрезается. */
export function Description({ text }: { text: string }) {
  return (
    <div className="notice description">
      <div className="description__label muted">Описание</div>
      {text}
    </div>
  );
}
