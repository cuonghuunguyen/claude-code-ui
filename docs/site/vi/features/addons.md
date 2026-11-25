# Addon {#addons}

Addon thay đổi giao diện và tính năng của claude-ui trong trình duyệt: giao diện màu, pane cạnh cuộc trò chuyện, một băng phía trên ô nhập, lệnh slash và cách vẽ khối mã hoặc kết quả công cụ. Bạn cài addon từ kho git hoặc thư mục cục bộ. Addon không phải [plugin](config-dialogs#how-to-open-them): plugin thay đổi Claude Code, addon thay đổi ứng dụng web này.

## Cài addon {#install}

1. Nhập `/addons` trong ô prompt, hoặc chọn **Quản lý addon** trong [bảng lệnh](palette).
2. Chọn **Kho git** và nhập URL, thêm nhánh, tag hoặc SHA nếu muốn. Hoặc chọn **Thư mục cục bộ** và nhập đường dẫn tuyệt đối trên máy chạy claude-ui.
3. **Cài.** claude-ui clone kho (git chạy không hỏi gì: dùng credential helper, ssh-agent và khóa ssh của bạn, không lưu gì), ghim commit và hiện **thẻ duyệt**.

`addon.json` của kho có thể nằm trong thư mục con, và một kho có thể chứa nhiều addon (như `npx skills add`). claude-ui tìm các tệp `addon.json` sâu tối đa ba cấp thư mục. Chỉ tìm thấy một addon: cài ngay. Tìm thấy nhiều: hiện danh sách, bạn tick các addon cần cài rồi chọn **Cài mục đã chọn**. `addon.json` hỏng vẫn được liệt kê nhưng không tick được. Mỗi addon có checkout, phần duyệt và cập nhật riêng. Thư mục cục bộ không được tìm kiếm: đường dẫn phải là thư mục của addon.

Addon nằm trên Hub (máy chạy claude-ui) và hoạt động ở mọi trình duyệt kết nối tới. Addon nằm trong thư mục dự án không bao giờ được chạy: chỉ addon bạn cài ở đây mới chạy.

## Duyệt quyền của addon {#approval}

Thẻ liệt kê addon xin quyền gì, mỗi quyền một dòng dễ hiểu, cùng giao diện màu, khung hiển thị, lệnh và bộ vẽ nó thêm vào. Addon có hiệu ứng thì có thêm dòng **Vẽ lên** ghi các phần của ứng dụng nó vẽ lên (hoặc **toàn cửa sổ**). **Duyệt và bật** để bật addon. Trước đó không có gì chạy. Addon chỉ làm được những gì bạn duyệt, và không bao giờ tự gửi prompt.

## Cập nhật, tắt, gỡ {#update}

- **Kiểm tra cập nhật** (addon git) hiện commit mới và các quyền được thêm hoặc bỏ. **Cập nhật** áp dụng đúng phiên bản đó.
- Phiên bản xin quyền chưa được duyệt sẽ tắt đến khi bạn duyệt. Thư mục cục bộ được đọc lại mỗi khi bạn mở hộp thoại: sửa thêm quyền cũng cần duyệt.
- Công tắc tắt addon mà không gỡ: giao diện màu, pane, băng, lệnh và bộ vẽ biến mất ngay. **Gỡ** xóa addon, và bản checkout với addon git.
- Trong hộp thoại, mỗi dòng có công tắc **Bật** và công tắc **Chế độ dev**, đều có nhãn chữ. Mô tả dài chỉ hiện hai dòng; **Xem thêm** và **Thu gọn** mở và gập phần còn lại.
- Dòng **Lỗi** cho biết vì sao addon không nạp được (thư mục mất, manifest hỏng).
- URL kho hiện không kèm tên người dùng hay mật khẩu.

## Addon làm được gì {#capabilities}

| Quyền | Cho phép |
| --- | --- |
| `session.read` | Đọc tin nhắn và kết quả công cụ của phiên nó hiện trong đó |
| `prompt.insert` | Điền chữ vào ô nhập (không bao giờ gửi) |
| `ui.status` | Hiện chữ trên thanh trạng thái |
| `ui.toast` | Hiện thông báo ngắn |
| `ui.pane` | Hiện pane cạnh cuộc trò chuyện |
| `ui.band` | Hiện băng phía trên ô nhập |
| `ui.command` | Thêm lệnh slash `/<addon>:<lệnh>` |
| `ui.effect` | Vẽ [hiệu ứng canvas](#effects) động lên các phần của ứng dụng hoặc cửa sổ (thấy kích thước và trạng thái, không bao giờ thấy nội dung) |
| `render.fence:<lang>` | Vẽ khối mã của ngôn ngữ đó |
| `render.tool:<name>` | Vẽ kết quả của công cụ đó |
| `net:<origin>` | Kết nối tới origin đó (ví dụ `https://api.github.com`) |

## Addon bị cô lập thế nào {#security}

- Mỗi khung hiển thị chạy trong iframe `sandbox="allow-scripts"`: không cookie, không lưu trữ, không truy cập ứng dụng. Nó không bao giờ nhận token của daemon.
- Daemon phục vụ tệp của addon tại `/addon/<nonce>/<tên>/…`, chỉ khi addon đang bật. Chính sách bảo mật nội dung chỉ cho script, style, ảnh và font từ thư mục của addon, và `fetch`/XHR chỉ tới các origin `net:` bạn đã duyệt. Giới hạn này chưa đầy đủ: trình duyệt không áp chính sách này cho WebRTC, nên hãy coi addon đọc được phiên của bạn (`session.read`) là mã đáng tin. API mà addon gọi phải cho phép origin `null` (CORS).
- Mọi yêu cầu từ khung đều qua cổng quyền. Thứ không có trong bảng trên (gửi prompt, tệp, shell, git, trả lời quyền) đều bị từ chối dù bạn đã duyệt gì. Lời gọi bị từ chối hiện một thông báo mỗi addon và được liệt kê dưới dòng của addon trong hộp thoại (trình duyệt này, trong bộ nhớ).
- Stylesheet của addon không tải được ảnh hay style từ bên ngoài: chính sách của ứng dụng chặn chúng.

## Manifest {#manifest}

`addon.json` ở gốc kho hoặc thư mục. Không có bước build: tệp dùng đúng như đã commit.

| Trường | Ý nghĩa |
| --- | --- |
| `name` | Chữ thường, chữ số và `-`, tối đa 64. Là không gian tên của lệnh và id pane. Không đổi giữa các phiên bản |
| `version`, `description` | Hiện trong hộp thoại |
| `capabilities` | Danh sách ở trên; mục nào cần quyền phải được bao phủ |
| `assets` | `{<id>: {path, label?}}`: các tệp ảnh addon đặt tên theo id, xem [tài nguyên và ảnh nền](#background). `path` có thể trỏ tới tệp chưa tồn tại |
| `claudeUi` | Khoảng phiên bản Claude UI mà addon chạy được, xem [tương thích](#compat). Bỏ trống: mọi phiên bản |
| `themes` | `[{id, name, light?, dark?, vars?, background?, options?, slots?, extends?, css?}]`, xem [giao diện màu](#themes), [slot](#slots) và [kế thừa](#extends). `css`: tệp `.css` chỉ áp dụng khi giao diện này được chọn, trong [lớp cascade `addon`](addon-parts#cascade) |
| `css` | Cũ. Tệp `.css` áp dụng khi addon đang bật, dù chọn giao diện nào, trong [lớp cascade `addon`](addon-parts#cascade). Quy tắc `:root` và `.dark` của nó cũng ảnh hưởng giao diện có sẵn: dùng `themes[].css` cho một giao diện |
| `views` | `[{id, title, entry, kind: "pane" \| "band", phone?}]`. `phone: false` ẩn khung dưới 640 px |
| `commands` | `[{name, description, argumentHint?}]` |
| `commandsEntry` | Tệp `.html` xử lý lệnh; mặc định là entry của khung đầu tiên |
| `renderers` | `[{fence \| tool, entry}]` |

Đường dẫn là tương đối, không có `..`, và phải tồn tại. Khung `pane` cần `ui.pane`, `band` cần `ui.band`, lệnh cần `ui.command`, bộ vẽ cần `render.fence:` hoặc `render.tool:`; lúc cài sẽ báo thiếu quyền nào.

## Nói chuyện với claude-ui từ một khung {#bridge}

Khung là tệp HTML nạp script riêng của nó (script nội tuyến bị chặn). Nó gửi `{v: 1, id, type, ...}` tới `parent` bằng `postMessage` và nhận lại `{v: 1, id, ok, result}` hoặc `{v: 1, id, ok: false, error: {code, message}}`.

| Yêu cầu | Cần | Tác dụng |
| --- | --- | --- |
| `ui.ready {height}` | không | Chiều cao của băng hoặc bản vẽ (24-480 px, băng tối đa 160) |
| `session.read` | `session.read` | `{parts}` của phiên; sau đó sự kiện `session.parts` mang phần mới hoặc đổi |
| `prompt.insert {text}` | `prompt.insert` | Chữ tới 32 KiB vào ô nhập (hoặc bản nháp) |
| `ui.status {text}` | `ui.status` | Mục thanh trạng thái tới 80 ký tự; `null` để xóa |
| `ui.toast {text}` | `ui.toast` | Thông báo tới 200 ký tự |

Sự kiện từ claude-ui: `init {addon, view, role, session, theme, mode}`, `theme.changed {theme, mode}`, `command.run {name, args}`, `render {fence: {lang, source}}` hoặc `render {tool: {name, input, result}}`, `session.parts`. **Chỉ xử lý thông điệp có `event.source` là `parent`:** mọi khung khác trên trang (addon khác, bản xem trước Artifact) cũng gửi được tới khung của bạn. SDK bên dưới bỏ qua các thông điệp đó.

## SDK {#sdk}

`packages/addon-sdk/` trong kho có hai tệp: `claude-ui-addon.js` (JavaScript thuần, không cần build) và `claude-ui-addon.d.ts` (kiểu của nó). Chép cả hai vào thư mục addon và import tệp đầu từ script của khung:

```js
// @ts-check
import { watchSession, setStatus, autoHeight } from "./claude-ui-addon.js";

autoHeight(); // băng hoặc bộ vẽ: báo claude-ui chiều cao nội dung
watchSession((parts) => setStatus(`${parts.filter((p) => p.type === "turn_result").length} turns`));
```

| Export | Làm gì |
| --- | --- |
| `call(type, payload)`, `on(type, fn)` | Mọi yêu cầu; mọi sự kiện (`on` trả về hàm gỡ handler) |
| `readSession()`, `insertPrompt(text)`, `setStatus(text)`, `toast(text)`, `log(text, level)`, `ready(height)` | Mỗi hàm một yêu cầu |
| `watchSession(fn)` | Đọc phiên sau `init`, rồi gọi `fn` với mọi phần mỗi khi có thay đổi |
| `autoHeight()` | Gửi chiều cao nội dung ngay và mỗi khi nó đổi |
| `AddonError` | Lỗi khi yêu cầu bị từ chối; `code` là `refused`, `bad_request` hoặc `unknown` |

SDK cũng đặt `color-scheme` của trang theo chế độ sáng hoặc tối của ứng dụng. Có `// @ts-check` ở đầu script thì VS Code và `tsc --checkJs` báo lỗi khi yêu cầu không tồn tại, payload sai hoặc trường mà phần không có. Kiểu đổi theo claude-ui: chép lại hai tệp sau khi cập nhật.

Để Claude viết addon cho bạn, cài plugin `addons` từ marketplace của kho này (`/plugin marketplace add cuonghuunguyen/claude-code-ui`, rồi `/plugin install addons@claude-ui`) và yêu cầu: skill `write-addon` của nó tạo thư mục, chép SDK và kiểm tra kiểu.

## Giao diện màu {#themes}

Giao diện màu có bảng `light` và `dark`; bạn có thể bỏ một chế độ (như Dracula không có light), nhưng chế độ đã khai báo phải đầy đủ: cài addon có bảng màu thiếu khóa hoặc không phải `#rrggbb` sẽ thất bại và nêu khóa còn thiếu. Bảng màu có đủ các khóa sau, mỗi khóa là màu `#rrggbb`: `bg`, `card`, `side`, `fg`, `muted`, `border`, `primary`, `pfg`, `kw`, `str`, `fn`, `type`, `num`, `cmt`, `varc`, `err`, `warn`, `ok`, `info`. Giao diện hiện trong **Cài đặt › Giao diện** sau các giao diện có sẵn, chỉ khi addon của nó đang bật. Nếu bạn tắt addon khi giao diện của nó đang chọn, giao diện mặc định hiện ra đến khi bạn chọn cái khác. Diff và terminal giữ màu mặc định với giao diện của addon. Để tạo kiểu cho giao diện ngoài màu sắc bằng `css`, hãy chọn các [phần](addon-parts) ổn định (`[data-part="tab"]`), không chọn tên class hay `data-testid`.

Bảng màu có thể có thêm khóa `graph`: danh sách đúng 8 màu `#rrggbb` cho các làn của Git graph (`--graph-1` đến `--graph-8`). 6 màu đầu cũng tô thanh ngữ cảnh (`--context-1` đến `--context-6`) trừ khi `vars` đặt chúng. Không có `graph` thì màu mặc định giữ nguyên. Mỗi màu nên đạt tương phản tối thiểu 3:1 trên `card`.

`vars` thêm thuộc tính CSS riêng của bạn, theo từng chế độ: `"vars": {"light": {"--glow": "none"}, "dark": {"--glow": "0 0 12px #00e5ff"}}`. Dùng trong `css` bằng `var(--glow)`. Var chỉ áp dụng khi giao diện được chọn, ở chế độ có bảng màu. Quy tắc: tối đa 64 var mỗi chế độ; tên khớp `--[a-z][a-z0-9-]*` (tối đa 41 ký tự sau dấu gạch); tên không được trùng token mà bảng màu đặt (`--background`, `--primary`, `--syntax-*`, `--graph-*`...: dùng khóa của bảng màu; `--context-*` được phép); giá trị dài 1 đến 200 ký tự, không có `;` `{` `}` `<` `>` `\` `@` hay xuống dòng, không có `/*`, ngoặc và dấu nháy cân bằng, và không có hàm tải ảnh (`url()`, `image-set()`...: ảnh sẽ đi qua trường `background` ở bản sau). Cài addon vi phạm quy tắc sẽ thất bại và nêu tên var.

Một giao diện có thể có tệp `css` riêng. Tệp chỉ áp dụng khi giao diện đó được chọn, nên không ảnh hưởng giao diện khác, kể cả giao diện có sẵn. Viết bộ chọn thường: `:root`, `html` và `.dark` vẫn là gốc trang, các bộ chọn khác khớp bên trong gốc. `@font-face` và `@property` vẫn toàn cục (không thuộc giao diện nào, nằm trong lớp của addon, nên đặt tên có tiền tố là tên addon: họ phông `@font-face` mà ứng dụng cũng dùng sẽ bị thay ở mọi giao diện). Tên `@keyframes`, `@counter-style` và `@font-palette-values` của bạn được đổi tên theo từng giao diện (`spin` thành `<addon>-<theme>--spin`, `animation`, `list-style` và `font-palette` đi theo), nên không thay được tên của ứng dụng. Bộ chọn bắt đầu bằng `*` (`*`, `* > .a`) cũng khớp gốc trang. `::-webkit-scrollbar` và bộ chọn khác không nêu phần tử nào chỉ khớp bên trong gốc: bắt đầu bằng `:root`. `@import` bị bỏ. Tệp được viết lại khi ứng dụng tải (CSS nesting; cần Chrome 120, Safari 17.2 hoặc Firefox 117, trình duyệt cũ hơn chỉ hiện bảng màu). Tệp lỗi cú pháp (thiếu `}` hoặc `*/`) hoặc lớn hơn 512 KB được phục vụ rỗng: giao diện giữ bảng màu và mất các quy tắc, hộp thoại Addons hiện một mục kiểm tra.

Chuyển addon cũ: `css` cấp cao nhất áp dụng cho mọi giao diện và ghi đè cả giao diện khác. Chuyển các quy tắc vào `themes[].css` của giao diện cần có chúng (hộp thoại Addons cảnh báo `top-level-css`).

Giao diện màu có thể khai báo tối đa 8 `options`: mỗi tùy chọn có một điều khiển trong **Settings › Appearance** khi giao diện đang được chọn. `id` là các từ chữ thường nối bằng `-` (tối đa 24 ký tự), `label` 1 đến 40 ký tự. `type` là một trong:

| `type` | Trường | Điều khiển | `--opt-<id>` | `data-opt-<id>` |
| --- | --- | --- | --- | --- |
| `boolean` (hoặc không có) | `default?` (thiếu nghĩa là `true`) | công tắc | `1` hoặc `0` | `on` hoặc `off` |
| `select` | `choices: [{value, label}]` (2 đến 12; `value` `[a-z0-9-]+`), `default?` (một trong các giá trị, nếu không thì giá trị đầu) | ô chọn | giá trị | giá trị |
| `range` | `min`, `max`, `step`, `default` (số, tối đa 3 chữ số thập phân, `min` < `max`, `step` > 0, `default` nằm trong khoảng) | thanh trượt kèm giá trị | số | không có |
| `color` | `default` (`#rrggbb`) | ô chọn màu | mã hex | không có |

Khi giao diện đang được chọn, `<html>` có các thuộc tính tùy biến này (và các thuộc tính `data-opt-*`); thuộc tính của tùy chọn giao diện khác bị xóa. Dùng chúng trong `css`: `:root[data-opt-rain="off"] .rain { display: none }`, `opacity: calc(var(--opt-density) * 0.4)`. Lựa chọn được giữ trong trình duyệt này; giá trị đã lưu không còn hợp lệ với tùy chọn (giá trị cũ, lựa chọn đã bị xóa, số ngoài `min` đến `max`) được thay bằng giá trị mặc định.

## Tài nguyên và ảnh nền {#background}

`assets` đặt tên cho các tệp ảnh theo id: `"assets": {"bg-dark": {"path": "art/dark.jpg", "label": "Ảnh nền tối"}}`. Id là các từ chữ thường nối bằng `-` (tối đa 24 ký tự), tối đa 16 tài nguyên. Đường dẫn là tương đối và kết thúc bằng `.png`, `.jpg`, `.jpeg`, `.webp`, `.avif`, `.gif` hoặc `.svg`. **Tệp có thể chưa có**: người dùng thêm sau, nên kho addon không phải chứa ảnh mà tác giả không có quyền chia sẻ. Hộp thoại Addons cảnh báo `asset-missing` cho đến khi có tệp và `asset-large` khi trên 2 MB. Tệp đã tồn tại phải nằm trong thư mục addon (liên kết trỏ ra ngoài làm manifest không hợp lệ).

`background` của giao diện đặt một trong các ảnh này phía sau ứng dụng:

```json
"background": { "light": { "image": "bg-light" }, "dark": { "image": "bg-dark", "mobile": "bg-phone" }, "veil": 0.4, "panelAlpha": 0.8 }
```

- `light`, `dark`: `image` hiển thị ở chế độ đó, và tùy chọn `mobile` dùng khi nhỏ hơn 768 px. Cả hai là id trong `assets`; id không có làm manifest không hợp lệ.
- `veil` (0 đến 1): màu nền trang phủ lên ảnh mạnh đến đâu, để chữ vẫn dễ đọc. Mặc định 0.
- `panelAlpha` (0 đến 1): các bảng chính (thanh bên, thanh tiêu đề, bảng phiên, hộp nhập, bảng bên) đục đến đâu trên ảnh. Mặc định 1, hoàn toàn đục. CSS của bạn có thể đổi `--panel-alpha`.

Ảnh nền chỉ hiển thị khi giao diện đang được chọn và tệp ảnh của chế độ hiện tại tồn tại. Không có tệp thì giao diện hoạt động như không có `background`, và các bảng vẫn đục. Ảnh là part `backdrop` (`<div data-part="backdrop">`, cố định phía sau ứng dụng) và `<html>` có `data-backdrop` khi ảnh hiển thị, để CSS của bạn thích ứng.

## Slot: loader, biểu tượng hoàn tất, biểu tượng gửi và chữ Thinking riêng {#slots}

Một giao diện có thể thay bốn thứ nhỏ của ứng dụng. `slots` nằm trong giao diện:

```json
"assets": { "ring": { "path": "art/ring.svg" }, "tick": { "path": "art/tick.svg" } },
"themes": [{ "id": "void", "name": "Void", "dark": { "...": "..." },
  "slots": {
    "loader": "ring",
    "done-icon": "tick",
    "send-icon": "ring",
    "thinking-phrases": { "en": ["Casting", "Expanding"], "vi": ["Đang niệm chú"] }
  } }]
```

| Slot | Giá trị | Hiển thị thay cho |
| --- | --- | --- |
| `loader` | Một id của asset | Vòng quay của lần gọi công cụ đang chạy, phiên đang chạy ở thanh bên và tab đang chạy. Part là [`loader`](addon-parts) |
| `done-icon` | Một id của asset | Dấu tích của lần gọi công cụ đã xong. Part là [`done-icon`](addon-parts) |
| `send-icon` | Một id của asset | Mũi tên của nút gửi. Biểu tượng Stop, Queue và ngoại tuyến giữ nguyên. Nút vẫn giữ tên cho trình đọc màn hình |
| `thinking-phrases` | `{<ngôn ngữ>: [câu]}` | Chữ "Thinking" của dòng đang làm việc |

- Slot ảnh ghi một id trong [`assets`](#background); id không có thì manifest không hợp lệ. Tệp có thể chưa tồn tại: ứng dụng giữ biểu tượng của mình và hộp thoại Addons cảnh báo `asset-missing`. Dùng `.svg`, `.png`, `.webp`, `.avif` hoặc `.gif`.
- Ảnh chỉ để trang trí (`alt` rỗng, ẩn với trình đọc màn hình) và có cỡ như biểu tượng nó thay (16 px). Ảnh không tự quay: hãy tạo chuyển động trong `css` của bạn (`[data-part="loader"] img { animation: ... }`, kèm `@media (prefers-reduced-motion: reduce)` hoặc `:root[data-motion="off"]`), hoặc dùng SVG tự chuyển động.
- Câu: 1 đến 4 ngôn ngữ, ngôn ngữ là `en`, `vi` hoặc bất kỳ `xx` / `xx-XX` (ứng dụng có `en` và `vi`), mỗi ngôn ngữ 1 đến 12 câu, mỗi câu 1 đến 60 ký tự văn bản thuần (không có `<`, `>` hay xuống dòng). Danh sách của ngôn ngữ giao diện được dùng (`pt-BR` trước `pt`); ngôn ngữ không có danh sách giữ "Thinking". Mỗi lượt chọn một câu trong danh sách và giữ nguyên đến hết lượt, nên không nhấp nháy và không chuyển động.
- `<html>` có `data-slot-loader`, `data-slot-done-icon`, `data-slot-send-icon` và `data-slot-thinking-phrases` khi slot đó đang có hiệu lực (tệp tồn tại; với câu: có danh sách cho ngôn ngữ giao diện). CSS của bạn có thể thích ứng, ví dụ ẩn vòng mà ảnh đã thay.

## Kế thừa giao diện khác {#extends}

`extends` cho một giao diện dựa trên giao diện khác, nên biến thể chỉ cần phần khác biệt: `"extends": "void"` (giao diện của cùng addon) hoặc `"extends": "pack:void"` (giao diện của addon `pack` đang bật).

Giao diện bắt đầu từ bản gốc rồi thêm phần của mình lên trên; phần của chính giao diện thắng:

- `css`, `vars`, `background`, `slots` và `options` của bản gốc áp dụng bên dưới phần của giao diện. `css` của bản gốc được nạp dưới giao diện kế thừa nên quy tắc của nó có hiệu lực ở đó. Tên `@keyframes`, `@counter-style`, `@font-palette-values` trong `css` của bản gốc (đã được đổi tên) dùng được trong `css` riêng của giao diện bằng tên gốc (`animation: spin 1s`).
- Bảng màu không được kế thừa: chế độ mà giao diện có là của chính nó. Chế độ không có thì dùng bảng màu của bản gốc.
- Bản gốc có thể kế thừa tiếp bản gốc khác, tối đa 3 mắc xích.

Khi không dùng được bản gốc (không có giao diện đó, addon của nó chưa cài hoặc chưa bật, bị lặp vòng, hơn 3 mắc xích) thì giao diện chạy không có nó và hộp thoại Addons cảnh báo `extends-missing`. Giá trị sai dạng, giao diện tự kế thừa chính nó và vòng lặp giữa các giao diện của cùng addon làm manifest không hợp lệ.

## Tương thích với Claude UI {#compat}

`claudeUi` cho biết addon chạy được với các phiên bản Claude UI nào: `"claudeUi": ">=1.6"`. Các dạng: `*` (mọi bản), `1.6.0` (đúng bản đó), `>=1.6` hoặc `>=1.6.2` (bản này trở lên), `^1.6` (cùng phiên bản chính, từ 1.6 trở lên), `~1.6` (cùng phiên bản phụ). Bỏ trống thì nhận mọi phiên bản. Ngoài khoảng đó addon có trạng thái **Error** với `needs Claude UI >=1.6 (this is 1.5.0)`, không được bật và không phục vụ tệp nào, nhưng vẫn nằm trong hộp thoại (addon git vẫn kiểm tra được bản cập nhật). Bản chạy từ mã nguồn (phiên bản `dev`) chấp nhận mọi khoảng.

## Pane, băng và lệnh {#views}

- Khung `pane` là pane như Files hay Plan: bắt đầu ở bảng bên, chuyển sang bảng dưới hoặc vùng chính từ menu tab, và có một tab cho mỗi phiên ở vùng chính. Bộ chuyển pane hẹp cũng liệt kê nó.
- Khung `band` nằm phía trên ô nhập của mọi phiên.
- Lệnh `/example:cmd` nằm trong danh sách `/`, chạy trong trình duyệt và không bao giờ được gửi. Lệnh không bao giờ che lệnh có sẵn hay skill: dòng của nó bị bỏ khi tên đã bị dùng.

## Vẽ khối mã và kết quả công cụ {#renderers}

Bộ vẽ `fence` vẽ khối mã của một ngôn ngữ trong câu trả lời và tin nhắn của bạn, trước các bộ vẽ có sẵn (cả sơ đồ Mermaid). Bộ vẽ `tool` vẽ kết quả của một công cụ. Mỗi bản vẽ có nút **Hiện bản gốc** để xem cách hiển thị có sẵn. Khung chỉ được tạo khi khối ở gần màn hình. Nếu hai addon vẽ cùng một thứ, hộp thoại Addon có bộ chọn; chưa chọn thì addon đứng đầu theo tên thắng.

## Hiệu ứng canvas trên các phần của ứng dụng {#effects}

Quyền `ui.effect`. Một hiệu ứng là một trang HTML của addon tự vẽ lên canvas của nó. Ứng dụng đặt nó lên một phần của ứng dụng (`target`: tên part) hoặc lên toàn cửa sổ (`target: "window"`), chỉ gửi kích thước, cờ trạng thái và giá trị các thuộc tính `data-*` công khai của part đó, các xung ngắn và màu của giao diện, không bao giờ gửi chữ hay dữ liệu phiên. Khung không nhận chuột hay bàn phím: nhấp, cuộn và gõ vẫn tới ứng dụng bên dưới.

```json
"capabilities": ["ui.effect"],
"effects": [{ "id": "aura", "target": "prompt-box", "entry": "effects/aura.html", "bleed": 24, "when": { "focus-within": true } }]
```

- `target`: `window` hoặc một part không cuộn: `titlebar`, `sidebar`, `work-area`, `session-area`, `session-header`, `side-panel`, `files-panel`, `graph-panel`, `terminal`, `permission-panel`, `question-panel`, `prompt-box`, `prompt-toolbar`, `send`, `context-meter`, `status-bar`, `focus-page`, `scroll-to-bottom`. Tên khác không bao giờ hiện (danh sách Kiểm tra báo điều này).
- `layer`: `above` (mặc định) hoặc `below`, chỉ cho `window`: vẽ phía sau ứng dụng, thấy được ở chỗ các panel trong suốt (giao diện đặt `--panel-alpha` trong `vars`, như với ảnh nền).
- `bleed`: số pixel tràn ra mỗi phía của part, từ 0 đến 64.
- `when`: hiện khi mọi khóa đều khớp: `focus-within`, `hover` (boolean), `attr:<tên data>` (`true` có, `false` không có, hoặc một giá trị). Chỉ đọc [thuộc tính trạng thái công khai](./addon-parts.md) của đích: `data-state`, `data-phase`, `data-just-finished`, `data-focus-opened`, `data-active`, `data-status`, `data-level` khi part có; với `window` là `data-phase` của trang.
- `watch`: thêm các thuộc tính đó để nhận trong `effect.state`. `option`: một tùy chọn boolean của giao diện trong addon để bật tắt hiệu ứng.
- Giới hạn: một khung cho mỗi part và addon, ba khung mỗi addon; canvas tối đa 1,2 megapixel (tỉ lệ điểm ảnh tối đa 2); tạm dừng khi part ra khỏi màn hình hoặc tab bị ẩn; một khung tĩnh khi giảm chuyển động. Hiệu ứng mất hơn 8 ms mỗi khung trong 10 giây bị dừng kèm thông báo đến khi tải lại trang.
- SDK chạy nó: `defineEffect({ frame(ctx, fx) { … }, pulse(name, fx) { … } })` đặt kích thước canvas, chạy vòng lặp hoạt ảnh, tạm dừng, mờ dần và báo chi phí mỗi khung.

## Viết và kiểm tra addon {#authoring}

Chạy `claude-ui addon dev <thư mục>` một lần: lệnh cài thư mục ở chế độ Dev (daemon theo dõi thư mục) và bật addon nếu nó không khai báo quyền. Lệnh in số cảnh báo lint và một dòng `preview: http://127.0.0.1:<port>/#/addon-preview`. Mỗi lần sửa tệp trong thư mục, manifest, lint và CSS được nạp lại mà không cần tải lại trang.

Mở **trang xem trước** (URL đó, hoặc **Mở xem trước** ở dòng addon trong Cài đặt › Addon). Trang hiện mọi [part](addon-parts) ở mọi trạng thái, bằng component thật của ứng dụng và dữ liệu mẫu: phiên đang chạy, chờ cấp quyền hoặc chờ câu trả lời, vừa xong, rảnh hoặc lỗi; thẻ công cụ ở cả sáu trạng thái; trạng thái tab, dòng thanh bên và nút gửi; ba mức dùng gói; trang Focus; toast và bảng lệnh. Chọn theme và **Sáng**, **Tối** hoặc **Theo hệ thống** ở đầu trang, sửa CSS và xem trang đổi. **Chạy lại hiệu ứng** chạy lại hai trạng thái 1,2 giây `data-just-finished` và `data-focus-opened`. Graph, thay đổi, nội dung commit và terminal cần daemon: trang hiện bản tĩnh thay thế, cùng tên part và thuộc tính. Cảnh báo lint của addon nằm ở mục **Kiểm tra** trong Cài đặt › Addon.

## Addon ví dụ {#example}

`examples/addons/example/` trong kho dùng SDK và minh họa mọi tính năng: giao diện màu, `theme.css`, một pane đếm số phần của phiên và có nút cho từng lời gọi cầu nối, một băng với số lượt và công cụ cuối, `/example:cmd`, và bộ vẽ cho khối ```` ```example ````. Hãy cài nó như thư mục cục bộ.

## Mod của Claude Code {#claude-code-mods}

*Mod* của Claude Code là plugin có module hooks, móc vào sự kiện của engine và có thể vẽ pane, băng, mục trạng thái và thông báo trong cửa sổ riêng của Claude Code. Nó không phải addon. claude-ui xử lý mod như sau (kiểm tra trên Claude Code 2.1.285, bản đi kèm claude-ui, với một mod thử bỏ đi):

- Module hooks của mod chỉ được nạp khi claude-ui khởi động với `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` trong môi trường; không có nó, mod không làm gì trong phiên claude-ui.
- Có nó, các hook của engine chạy trong phiên claude-ui (gọi công cụ, prompt, bắt đầu phiên). Lệnh mod đăng ký chạy được khi bạn gõ, nhưng không có trong danh sách `/`.
- Pane, mục trạng thái và thông báo của mod tới claude-ui dưới dạng các thông điệp hệ thống nhỏ, và claude-ui không vẽ cái nào: dòng thời gian hiện một dòng xám như `system/ui_status`. Pane của mod không có nội dung ở đây.

Muốn thay đổi chính claude-ui, hãy viết addon.
