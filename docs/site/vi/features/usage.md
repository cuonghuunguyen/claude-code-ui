# Mức dùng & ngữ cảnh {#usage-context}

Hai đồng hồ nhỏ cho biết bạn còn lại bao nhiêu.

| Đồng hồ | Vị trí | Hiển thị |
| --- | --- | --- |
| **Mức dùng gói** | Góc trên bên phải cửa sổ | Bạn đã dùng bao nhiêu giới hạn của gói Claude |
| **Cửa sổ ngữ cảnh** | Cạnh nút gửi | Ngữ cảnh của phiên này đầy đến đâu |

## Mức dùng gói {#plan-usage}

1. Nhìn vào vòng tròn ở góc trên bên phải. Nó hiển thị một phần trăm.
2. Bấm vào để xem mọi cửa sổ, như **Phiên hiện tại** và **Tuần hiện tại (mọi model)**, kèm thời điểm mỗi cửa sổ đặt lại.
3. Vòng tròn chuyển thành biểu tượng cảnh báo khi bạn gần chạm giới hạn, và hiển thị **Đã đạt giới hạn** khi bạn chạm giới hạn.

Với `CLAUDE_CODE_OAUTH_TOKEN` (từ `claude setup-token`), vòng tròn hiển thị cửa sổ phiên và cửa sổ tuần sau một lượt, hoặc vòng tròn xám với **–** trước đó: token đó không đọc được mức dùng gói. Chạy `claude login` để xem mọi cửa sổ.

Chọn cửa sổ mà vòng tròn hiển thị trong [Cài đặt › Giới hạn mức dùng](../reference/settings#usage-limits): Mức dùng cao nhất, Phiên (5 giờ) hoặc Tuần.

## Tiếp tục sau khi đạt giới hạn {#continue-after-a-limit}

Khi một phiên dừng vì giới hạn của gói, claude-code-ui có thể gửi "continue" cho phiên đó sau khi giới hạn đặt lại.

1. Bật **Tự động tiếp tục sau khi giới hạn mức dùng đặt lại** trong **Cài đặt › Giới hạn mức dùng**.
2. Một ghi chú phía trên ô nhập prompt cho biết khi nào phiên sẽ tiếp tục. **Hủy tự động tiếp tục** sẽ dừng việc đó.

Tự gửi tin nhắn cũng hủy việc này. Nhiều phiên đã dừng sẽ tiếp tục lần lượt từng phiên.

## Cửa sổ ngữ cảnh {#context-window}

- Bấm vào vòng tròn cạnh nút gửi để xem thứ gì làm đầy ngữ cảnh: tin nhắn, system prompt, công cụ, công cụ MCP, tệp bộ nhớ và skill.
- Nó cũng hiển thị token và chi phí của phiên.

## Cần biết {#good-to-know}

- Số liệu lấy từ tài khoản Claude của bạn, giống `/usage` trong Claude Code.
- Khởi động lại daemon sẽ làm mất các lần tiếp tục đã lên lịch.
- Thanh trạng thái dưới ô nhập prompt hiển thị token đầu vào, đầu ra và token đã lưu đệm của phiên.
