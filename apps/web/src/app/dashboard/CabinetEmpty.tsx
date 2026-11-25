import { PreviewStart } from '../preview/PreviewStart';
import { CreateBotForm } from './BotListScreen';

export function CabinetEmpty({ pdf = false }: { pdf?: boolean } = {}) {
  return <><div className="cabinet-head"><h1>Мои боты</h1></div>
    <section className="card stack cabinet-start" aria-labelledby="empty-title">
      <h2 id="empty-title">Ботов пока нет</h2>
      <ol className="setup-steps" aria-label="Этапы настройки"><li aria-current="step">Материалы</li><li>Проверка</li><li>Установка</li></ol>
      {pdf ? <><h3>Создайте бота для PDF</h3>
        <p>После создания откроется выбор файла. Нужен текстовый PDF до 10 МБ и 100 страниц.</p><CreateBotForm pdf /></>
        : <><p>Начните с материалов сайта, затем проверьте ответы перед установкой.</p>
          <PreviewStart signedIn /><details><summary>Создать бота вручную</summary><CreateBotForm /></details></>}
    </section></>;
}
