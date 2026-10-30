# Quyền riêng tư

**Tóm tắt:** mọi thứ nằm trên máy của bạn. Không có máy chủ claude-code-ui, không có tài khoản và không có telemetry.

## Những gì ở lại máy {#what-stays-local}

- **Daemon và ứng dụng web** chạy trên máy tính của bạn. Không có gì được lưu trữ ở nơi khác.
- **Lịch sử phiên** là các tệp transcript của chính Claude Code trong `~/.claude/projects/`. claude-code-ui không có cơ sở dữ liệu riêng.
- **Dữ liệu riêng của nó** (token ghép nối, danh sách dự án, cài đặt) nằm trong [thư mục cấu hình](cli#files).
- **Đăng nhập Claude của bạn** ở lại trong daemon. Nó không bao giờ được gửi tới trình duyệt.

## Những gì rời khỏi máy {#what-leaves-your-machine}

| Gì | Đi đâu | Vì sao |
| --- | --- | --- |
| Prompt và ngữ cảnh mã của bạn | Anthropic | Đó là cách Claude hoạt động, giống CLI `claude` |
| "Phiên bản mới nhất là gì?" | npm (`registry.npmjs.org`) | [Kiểm tra cập nhật](../features/updates). Không gửi thông tin nào về bạn. Tắt bằng `--no-update-check`. |
| Thông báo đẩy | Dịch vụ đẩy của trình duyệt (Google, Apple, Mozilla) | Chỉ khi bạn bật thông báo đẩy. Mã hóa đầu cuối: dịch vụ đẩy không đọc được nội dung. |

## Truy cập từ xa {#remote-access}

- Mặc định daemon chỉ lắng nghe trên `127.0.0.1`: không ai khác truy cập được.
- Với điện thoại, dùng Tailscale: riêng tư cho các thiết bị của bạn, có HTTPS. Tailscale Funnel công khai không bao giờ được dùng.
- `--lan` là HTTP thuần. Chỉ dùng trên mạng bạn tin cậy.

## Kiểm soát truy cập {#access-control}

- Mỗi kết nối cần token ghép nối. Giữ liên kết ghép nối riêng tư: nó cấp toàn quyền truy cập.
- **Daemon có thể chạy bất kỳ lệnh nào trên máy tính của bạn.** Coi quyền truy cập vào nó như quyền truy cập shell.
- Phiên, tệp và terminal nằm trong các thư mục gốc được phép (`--roots`).
- Yêu cầu quyền được bật mặc định. Chế độ "Bypass permissions" bị ẩn trừ khi bạn khởi động với `--allow-bypass`.
- Để hủy ghép nối mọi trình duyệt, xóa tệp `token` trong thư mục cấu hình và khởi động lại.

## Đăng nhập {#login}

claude-code-ui dùng đăng nhập theo gói đăng ký Claude của bạn (`claude login`), không dùng khóa API. Đây là công cụ cá nhân: một người dùng, trên máy của họ, với gói đăng ký của họ.

Các quyết định thiết kế: [docs/adr](https://github.com/cuonghuunguyen/claude-code-ui/tree/main/docs/adr).
