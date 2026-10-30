# Đọc một phiên {#reading-a-session}

Phần giữa màn hình là **dòng thời gian**: các prompt của bạn, câu trả lời của Claude và mọi việc Claude đã làm, mới nhất ở dưới cùng.

![Một phiên: prompt, các thẻ công cụ và một câu trả lời](/screenshots/session.png)

## Bạn thấy gì {#what-you-see}

- **Thẻ công cụ:** một thẻ cho mỗi việc Claude đã làm. Bấm vào thẻ để mở.
  - Bash: lệnh và kết quả của nó.
  - Edit và Write: diff của thay đổi.
  - Read, Grep, Glob: tệp hoặc mẫu tìm kiếm.
  - TodoWrite: danh sách việc cần làm của Claude. Khi Claude làm việc, danh sách cũng nằm phía trên ô nhập prompt.
  - Agent: một lần chạy subagent. Mở ra để xem dòng thời gian riêng của subagent.
  - Bash chạy nền: xem [Shell nền](background-shells).
  - Artifact: một trang Claude đã xuất bản. Thẻ hiển thị bản xem trước. **Mở trong tab** hiển thị nó trong tab riêng, và khung Artifacts liệt kê toàn bộ artifact của phiên (xem [Khung & bố cục](panes)).
- **Câu trả lời Markdown** với tô sáng mã, bảng, công thức toán và sơ đồ Mermaid.
- **Prompt dính:** khi bạn cuộn lên, prompt của lượt bạn đang đọc nằm cố định ở đầu. Bấm vào nó để nhảy tới đó.

## Cách dùng {#how-to-use}

| Để | Làm |
| --- | --- |
| Gập mọi lệnh gọi công cụ thành một dòng | Bật **Chỉ tín hiệu** (<kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>S</kbd>) |
| Sao chép câu trả lời của Claude | **Sao chép phản hồi** dưới một lượt đã xong |
| Trích một phần câu trả lời | Chọn văn bản, bấm **Trích dẫn vào prompt** |
| Mở ảnh lớn | Bấm vào ảnh |
| Quay lại quá khứ | Di chuột lên prompt của bạn, bấm **Quay lại trước tin nhắn này** |

## Tua lại {#rewind}

Tua lại đưa phiên về trạng thái trước một prompt của bạn. Chọn thứ cần khôi phục:

- **Khôi phục mã và cuộc trò chuyện**
- **Khôi phục cuộc trò chuyện** (tệp giữ nguyên)
- **Khôi phục mã** (cuộc trò chuyện giữ nguyên)

Bạn cũng có thể chạy “Quay lại” từ [bảng lệnh](palette). Không thể tua lại khi Claude đang làm việc.

## Cần biết {#good-to-know}

- **Chỉ tín hiệu** áp dụng cho mọi phiên trong trình duyệt này. Prompt của bạn, văn bản của Claude, lỗi và các yêu cầu đang chờ bạn luôn hiển thị.
- Tua lại mã chỉ bao gồm các thay đổi do công cụ Edit và Write của Claude thực hiện. Nó không hoàn tác lệnh shell.
- Phiên dài tải các lượt mới nhất trước. Cuộn lên để xem các lượt cũ hơn.
- Nút sao chép cần HTTPS hoặc `localhost`.
