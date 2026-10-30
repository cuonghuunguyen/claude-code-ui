# Cờ CLI

```sh
claude-ui [options]
claude-ui update     # install the latest version; the next start runs it
claude-ui <command>  # ask the running daemon (below)
```

Ví dụ:

```sh
claude-ui --port 5000 --roots ~/projects:~/oss
```

## Lệnh {#commands}

Các lệnh này giao tiếp với daemon đang chạy trên máy tính này. Chúng không bao giờ khởi động daemon và không bao giờ tạo tệp token.

| Lệnh | Chức năng |
| --- | --- |
| `status` | Daemon có chạy không, phiên bản, cổng, số phiên theo trạng thái |
| `open [sessionId] [--print]` | Mở claude-ui trong trình duyệt. `--print` in liên kết thay vì mở. Khi không có session id, liên kết chứa token ghép nối; khi có, đó là liên kết thường cho trình duyệt đã được ghép nối |
| `sessions` (`ls`) | Liệt kê phiên. `--project <dir>`, `--state <idle\|running\|needs_input\|error\|closed>`, `--archived` (hiện cả phiên đã lưu trữ) |
| `projects` | Liệt kê dự án |
| `workers` | Liệt kê worker điều phối theo coordinator |

Tùy chọn của mọi lệnh: `--json` (cho máy đọc; có thể được thêm trường), `--port <n>` (mặc định: cổng của daemon đang chạy lấy từ `daemon.json`, nếu không thì `PORT`, nếu không thì `4280`), `--token-file <path>` (mặc định: `CLAUDE_UI_TOKEN_FILE`, nếu không thì `token` trong thư mục cấu hình).

Mã thoát: `0` thành công, `1` daemon từ chối (ví dụ session id không tồn tại), `2` dùng sai, `3` daemon không chạy hoặc thiếu token hoặc token bị từ chối. Chỉ `open --print` ghi token ra terminal.

Sau `claude-ui update`, lệnh `claude-ui` toàn cục vẫn là bản cũ: chạy `npm i -g claude-code-ui` để có launcher mới. Launcher cũ coi một lệnh thất bại trong vòng 10 giây (ví dụ `status` khi không có daemon chạy) là bản mới bị lỗi.

Chưa có: `new`, `send`, `tail`, `interrupt`, `doctor`, `logs`, `stop` (tên được giữ chỗ). Không thể truy cập daemon trên Windows từ WSL; hãy chạy `claude-ui` trong PowerShell.

## Cờ {#flags}

| Cờ | Biến môi trường | Mặc định | Chức năng |
| --- | --- | --- | --- |
| `--port <n>` | `PORT` | `4280` | Cổng lắng nghe |
| `--roots <paths>` | `CLAUDE_UI_ROOTS` | thư mục home của bạn | Các thư mục mà phiên, tệp và terminal được dùng. Phân tách như `PATH`: `:` (Windows: `;`) |
| `--tailscale` | `CLAUDE_UI_TAILSCALE=1` | tắt | Phục vụ trên tailnet của bạn bằng `tailscale serve` và in liên kết HTTPS. Xem [Điện thoại và truy cập từ xa](../features/remote-access) |
| `--hostname <name>` | `CLAUDE_UI_HOSTNAME` | | Tên HTTPS của proxy riêng của bạn đặt trước daemon. Không dùng chung với `--tailscale` |
| `--lan` | `CLAUDE_UI_LAN=1` | tắt | Lắng nghe thêm trên mạng cục bộ, HTTP thuần |
| `--allow-bypass` | `CLAUDE_UI_ALLOW_BYPASS=1` | tắt | Cung cấp chế độ "Bypass permissions" |
| `--no-update-check` | `CLAUDE_UI_UPDATE_CHECK=0` | có kiểm tra | Không kiểm tra npm để tìm phiên bản mới |
| `--no-os-notify` | `CLAUDE_UI_OS_NOTIFY=0` | bật | Không hiện thông báo màn hình nền trên máy tính này |
| `--no-open` | `CLAUDE_UI_OPEN=0` | mở | Không mở giao diện web trong trình duyệt của máy tính này khi khởi động. Không bao giờ mở sau khi khởi động lại do cập nhật, qua SSH, hoặc trên Linux không có màn hình |
| `-v`, `--version` | | | In phiên bản |
| `-h`, `--help` | | | In trợ giúp |

Cờ được ưu tiên hơn biến môi trường tương ứng.

## Biến môi trường {#environment-variables}

Chỉ có dưới dạng biến môi trường:

| Biến | Mặc định | Chức năng |
| --- | --- | --- |
| `CLAUDE_UI_IDLE_CLOSE_MINUTES` | `10` | Đóng tiến trình Claude của phiên rảnh mà không tab nào hiển thị sau số phút này. `0` = không bao giờ. Prompt tiếp theo sẽ tiếp tục phiên. |
| `CLAUDE_UI_UPDATE_REGISTRY` | npm | Bản sao registry npm dùng cho cập nhật. Phải là `https://` (`http://` thuần chỉ trên localhost). |
| `CLAUDE_UI_CLAUDE_BIN` | bản đi kèm | Đường dẫn tới một binary Claude Code khác. |

## Tệp {#files}

**Thư mục cấu hình** chứa dữ liệu riêng của daemon:

| Hệ điều hành | Thư mục cấu hình |
| --- | --- |
| Linux, macOS | `$XDG_CONFIG_HOME/claude-ui`, nếu không thì `~/.config/claude-ui` |
| Windows | `%APPDATA%\claude-ui` (hoặc `~/.config/claude-ui` nếu thư mục đó đã tồn tại hoặc `XDG_CONFIG_HOME` được đặt) |

| Tệp | Chứa |
| --- | --- |
| `daemon.json` | Cổng, pid, phiên bản và thời điểm khởi động của daemon đang chạy (không có token). Bị xóa khi daemon thoát |
| `token` | Token ghép nối. Xóa nó rồi khởi động lại để hủy ghép nối mọi trình duyệt. |
| `projects.json` | Danh sách dự án của bạn |
| `sessions.json` | Model, chế độ, effort và liên kết worker của mỗi phiên |
| `settings.json` | Cài đặt toàn ứng dụng (xem [Cài đặt](settings)) |
| `vapid.json`, `push-subscriptions.json` | Khóa thông báo đẩy và các trình duyệt đã đăng ký |
| `sides.json`, `side-pack/` | Các side WSL và Docker |
| `versions/` | Các bản cập nhật đã cài |

Bản thân lịch sử phiên không nằm ở đây. Nó nằm trong transcript của chính Claude Code tại `~/.claude/projects/`.
