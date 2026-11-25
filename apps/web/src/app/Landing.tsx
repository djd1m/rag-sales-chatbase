import type { Theme } from '../lib/theme';
import { PreviewStart } from './preview/PreviewStart';
import { SiteHeader } from './SiteHeader';
// arrival — строка входа по бейджу или демо-странице (FR-GROWTH-003): «Бот как на <домен> — для вашего сайта».
export function Landing({ theme, arrival = null }: { theme: Theme; arrival?: string | null }) {
  return <><SiteHeader theme={theme} />
    <main className="landing">
      <section className="hero center" aria-labelledby="hero-title">
        <div className="hero-copy">
          {arrival && <p className="arrival-line muted">{arrival}</p>}
          <h1 id="hero-title">Бот для клиентов по вашим материалам</h1>
          <p className="intro">Укажите сайт и задайте вопрос. Вы увидите ответ и фрагмент страницы, на котором он основан.</p>
          <PreviewStart />
        </div>
        <aside className="card answer-card stack" aria-labelledby="example-title">
          <h2 id="example-title">Пример диалога</h2>
          <p className="question">Сколько стоит чистка зубов?</p>
          <p className="answer">Профессиональная гигиена — 4 500 ₽, приём длится около часа.</p>
          <p className="source-plate"><span>Источник:</span> <strong>Цены на услуги</strong></p>
          <blockquote>«Гигиена полости рта — 4 500 ₽. Длительность приёма — 60 минут».</blockquote>
        </aside>
      </section>
      <section className="section center" aria-labelledby="how-title">
        <h2 id="how-title">Как это работает</h2>
        <ol className="steps">
          <li><div><h3>Адрес сайта</h3><p>Вставляете адрес — мы читаем открытые страницы, соблюдая robots.txt.</p></div></li>
          <li><div><h3>Материалы</h3><p>Добавляете PDF: прайс, условия, памятки для клиентов.</p></div></li>
          <li><div><h3>Проверка</h3><p>Задаёте вопросы в предпросмотре и видите, из какого места взят каждый ответ.</p></div></li>
          <li><div><h3>Установка</h3><p>Вставляете одну строку кода на сайт — бот отвечает посетителям.</p></div></li>
        </ol>
      </section>

      <section className="section center" aria-labelledby="who-title">
        <h2 id="who-title">Для кого</h2>
        <ul className="plain-list">
          <li>Клиники, салоны, автосервисы — вопросы о ценах, записи и адресе приходят в любое время.</li>
          <li>Интернет-магазины — доставка, возврат, гарантия.</li>
          <li>Студии, которые делают сайты клиентам, — бот как часть сдачи проекта.</li>
        </ul>
      </section>
      <section className="section center" aria-labelledby="trust-title">
        <h2 id="trust-title">Чему можно доверять</h2>
        <ul className="plain-list">
          <li>Бот отвечает только по вашим материалам. Нет подходящего фрагмента — «не знаю» и ваш контакт, а не выдумка.</li>
          <li>Материалы и фрагменты хранятся в нашей базе; текст вопроса для ответа передаётся языковой модели — условия обработки по 152-ФЗ обсуждаем с каждым пилотным клиентом.</li>
          <li>Удаление аккаунта стирает ваши материалы и вопросы посетителей в течение 72 часов.</li>
        </ul>
      </section>
      <section className="section center" aria-labelledby="plans-title">
        <h2 id="plans-title">Тарифы</h2>
        <p>Бесплатный план — с подписью «Работает на Суфлёре» в окне чата. Снять подпись можно на плане «Для своего сайта».</p>
        <a className="button secondary" href="/pricing">Сравнить планы</a>
      </section>
      <section className="section center faq" aria-labelledby="faq-title">
        <h2 id="faq-title">Вопросы</h2>
        <details><summary>Нужно ли регистрироваться, чтобы попробовать?</summary><p>Нет. Бот собирается и отвечает до регистрации; аккаунт нужен, чтобы сохранить его и получить код установки.</p></details>
        <details><summary>Какие сайты подходят?</summary><p>Открытые страницы без входа по паролю. Страницы, закрытые в robots.txt, мы не читаем.</p></details>
        <details><summary>Что будет, если бот не знает ответа?</summary><p>Он честно говорит «не знаю» и показывает ваш телефон, почту или ссылку.</p></details>
      </section>
    </main></>;
}
