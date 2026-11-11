# Hình minh họa trong trò chuyện

Claude có thể vẽ biểu đồ, sơ đồ hoặc widget tương tác nhỏ ngay trong câu trả lời.

## Cách dùng {#how-to-use}

1. Yêu cầu một hình: "visualize doanh số theo tháng dạng biểu đồ cột".
2. Claude ghi hình vào một tệp trong thư mục uploads của phiên và hiện nó trong cuộc trò chuyện. Khi đang viết bạn thấy "Đang vẽ…"; hình hiện khi khối hoàn chỉnh. Xóa phiên thì tệp bị xóa theo: các câu trả lời cũ báo không đọc được tệp.
3. **Show code** phía trên hình đổi hình thành mã nguồn của nó.

Tắt trong [Cài đặt › Sessions › Chat](../reference/settings#chat). Áp dụng cho phiên bắt đầu hoặc tiếp tục sau khi đổi. Tắt: hình hiện dưới dạng mã.

## Cần biết {#good-to-know}

- Hình chạy trong khung sandbox. Hình không đọc được ứng dụng, tệp, cookie hay bộ nhớ của bạn, và không gửi được yêu cầu mạng. Script chỉ tải inline hoặc từ `cdn.jsdelivr.net`, `cdnjs.cloudflare.com` và `unpkg.com`.
- Script trong hình vẫn có thể đưa dữ liệu vào địa chỉ của script CDN. Claude đã có thể ghi tệp nên rủi ro này nhỏ, nhưng bạn nên biết.
- Hình theo giao diện sáng/tối và giao diện màu.
- Trong câu hỏi của Claude, hình có thể hiện trong câu hỏi và cạnh từng lựa chọn, đặt cạnh nhau để so sánh. Hình tương tác ở đó (thanh trượt, xếp hạng) có thể điền vào ô câu trả lời riêng; bạn vẫn bấm Submit.
- Hoạt động trên môi trường Docker, WSL và SSH (sau khi môi trường cập nhật lên bản này) và với engine OpenCode. OpenCode nhận hướng dẫn kèm mỗi prompt, nên đổi cài đặt áp dụng từ prompt tiếp theo.
