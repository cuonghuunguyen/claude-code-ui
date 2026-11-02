# Addon {#addons}

Addon thay đổi giao diện và tính năng của claude-ui trong trình duyệt: giao diện màu, pane cạnh cuộc trò chuyện, một băng phía trên ô nhập, lệnh slash và cách vẽ khối mã hoặc kết quả công cụ. Bạn cài addon từ kho git hoặc thư mục cục bộ. Addon không phải [plugin](config-dialogs#how-to-open-them): plugin thay đổi Claude Code, addon thay đổi ứng dụng web này.

## Cài addon {#install}

1. Nhập `/addons` trong ô prompt, hoặc chọn **Quản lý addon** trong [bảng lệnh](palette).
2. Chọn **Kho git** và nhập URL, thêm nhánh, tag hoặc SHA nếu muốn. Hoặc chọn **Thư mục cục bộ** và nhập đường dẫn tuyệt đối trên máy chạy claude-ui.
3. **Cài.** claude-ui clone kho (git chạy không hỏi gì: dùng credential helper, ssh-agent và khóa ssh của bạn, không lưu gì), ghim commit và hiện **thẻ duyệt**.

Addon nằm trên Hub (máy chạy claude-ui) và hoạt động ở mọi trình duyệt kết nối tới. Addon nằm trong thư mục dự án không bao giờ được chạy: chỉ addon bạn cài ở đây mới chạy.

## Duyệt quyền của addon {#approval}

Thẻ liệt kê addon xin quyền gì, mỗi quyền một dòng dễ hiểu, cùng giao diện màu, khung hiển thị, lệnh và bộ vẽ nó thêm vào. **Duyệt và bật** để bật addon. Trước đó không có gì chạy. Addon chỉ làm được những gì bạn duyệt, và không bao giờ tự gửi prompt.

## Cập nhật, tắt, gỡ {#update}

- **Kiểm tra cập nhật** (addon git) hiện commit mới và các quyền được thêm hoặc bỏ. **Cập nhật** áp dụng đúng phiên bản đó.
- Phiên bản xin quyền chưa được duyệt sẽ tắt đến khi bạn duyệt. Thư mục cục bộ được đọc lại mỗi khi bạn mở hộp thoại: sửa thêm quyền cũng cần duyệt.
- Công tắc tắt addon mà không gỡ: giao diện màu, pane, băng, lệnh và bộ vẽ biến mất ngay. **Gỡ** xóa addon, và bản checkout với addon git.
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
| `themes` | `[{id, name, light?, dark?}]`, xem [giao diện màu](#themes) |
| `css` | Tệp `.css` áp dụng toàn ứng dụng khi addon đang bật |
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

Sự kiện từ claude-ui: `init {addon, view, role, session, theme, mode}`, `theme.changed {theme, mode}`, `command.run {name, args}`, `render {fence: {lang, source}}` hoặc `render {tool: {name, input, result}}`, `session.parts`. `bridge.js` của ví dụ gói việc này thành `call(type, payload)` và `on(type, fn)`. **Chỉ xử lý thông điệp có `event.source` là `parent`:** mọi khung khác trên trang (addon khác, bản xem trước Artifact) cũng gửi được tới khung của bạn, và `bridge.js` bỏ qua các thông điệp đó.

## Giao diện màu {#themes}

Giao diện màu có bảng `light` và `dark`; chế độ thiếu hoặc không đủ sẽ không được đưa ra (như Dracula không có light). Bảng màu có đủ các khóa sau, mỗi khóa là màu `#rrggbb`: `bg`, `card`, `side`, `fg`, `muted`, `border`, `primary`, `pfg`, `kw`, `str`, `fn`, `type`, `num`, `cmt`, `varc`, `err`, `warn`, `ok`, `info`. Giao diện hiện trong **Cài đặt › Giao diện** sau các giao diện có sẵn, chỉ khi addon của nó đang bật. Nếu bạn tắt addon khi giao diện của nó đang chọn, giao diện mặc định hiện ra đến khi bạn chọn cái khác. Diff và terminal giữ màu mặc định với giao diện của addon.

## Pane, băng và lệnh {#views}

- Khung `pane` là pane như Files hay Plan: bắt đầu ở bảng bên, chuyển sang bảng dưới hoặc vùng chính từ menu tab, và có một tab cho mỗi phiên ở vùng chính. Bộ chuyển pane hẹp cũng liệt kê nó.
- Khung `band` nằm phía trên ô nhập của mọi phiên.
- Lệnh `/example:cmd` nằm trong danh sách `/`, chạy trong trình duyệt và không bao giờ được gửi. Lệnh không bao giờ che lệnh có sẵn hay skill: dòng của nó bị bỏ khi tên đã bị dùng.

## Vẽ khối mã và kết quả công cụ {#renderers}

Bộ vẽ `fence` vẽ khối mã của một ngôn ngữ trong câu trả lời và tin nhắn của bạn, trước các bộ vẽ có sẵn (cả sơ đồ Mermaid). Bộ vẽ `tool` vẽ kết quả của một công cụ. Mỗi bản vẽ có nút **Hiện bản gốc** để xem cách hiển thị có sẵn. Khung chỉ được tạo khi khối ở gần màn hình. Nếu hai addon vẽ cùng một thứ, hộp thoại Addon có bộ chọn; chưa chọn thì addon đứng đầu theo tên thắng.

## Addon ví dụ {#example}

`examples/addons/example/` trong kho minh họa mọi tính năng: giao diện màu, `theme.css`, một pane đếm số phần của phiên và có nút cho từng lời gọi cầu nối, một băng với số lượt và công cụ cuối, `/example:cmd`, và bộ vẽ cho khối ```` ```example ````. Hãy cài nó như thư mục cục bộ.

## Mod của Claude Code {#claude-code-mods}

*Mod* của Claude Code là plugin có module hooks, móc vào sự kiện của engine và có thể vẽ pane, băng, mục trạng thái và thông báo trong cửa sổ riêng của Claude Code. Nó không phải addon. claude-ui xử lý mod như sau (kiểm tra trên Claude Code 2.1.285, bản đi kèm claude-ui, với một mod thử bỏ đi):

- Module hooks của mod chỉ được nạp khi claude-ui khởi động với `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` trong môi trường; không có nó, mod không làm gì trong phiên claude-ui.
- Có nó, các hook của engine chạy trong phiên claude-ui (gọi công cụ, prompt, bắt đầu phiên). Lệnh mod đăng ký chạy được khi bạn gõ, nhưng không có trong danh sách `/`.
- Pane, mục trạng thái và thông báo của mod tới claude-ui dưới dạng các thông điệp hệ thống nhỏ, và claude-ui không vẽ cái nào: dòng thời gian hiện một dòng xám như `system/ui_status`. Pane của mod không có nội dung ở đây.

Muốn thay đổi chính claude-ui, hãy viết addon.
