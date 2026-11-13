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
| Quay lại quá khứ | Di chuột lên prompt của bạn, bấm **Tua lại trước tin nhắn này** |

## Tua lại {#rewind}

Tua lại đưa phiên về trạng thái trước một prompt của bạn. Chọn thứ cần khôi phục:

- **Khôi phục mã và cuộc trò chuyện**
- **Khôi phục cuộc trò chuyện** (tệp giữ nguyên)
- **Khôi phục mã** (cuộc trò chuyện giữ nguyên)

Bạn cũng có thể chạy “Tua lại” từ [bảng lệnh](palette). Không thể tua lại khi Claude đang làm việc.

## Tôi sẽ quay lại {#ill-be-back}

**Tôi sẽ quay lại** (nút cạnh **Copy response** dưới câu trả lời đã xong) đánh dấu câu trả lời để quay lại sau.

1. Bấm nút. Phiên viết một bản tóm tắt ngắn về công việc (**Về**, **Tập trung vào**, **Tiếp theo**) dưới dạng một lượt hiện thành một dòng thu gọn, "Brief for your mark". Phiên đang bận viết nó sau lượt hiện tại.
2. Trong bảng dưới câu trả lời, thêm **Ghi chú** (tối đa 280 ký tự) và **Nhắc tôi sau** (một số kèm m, h hoặc d, từ 1m đến 7d: `30m`, `2h`, `1d`). Lời nhắc chỉ kích hoạt một lần.
3. Mở bản tóm tắt sau đó: nó cho biết đã qua bao nhiêu lượt kể từ khi viết, và **Làm mới tóm tắt** viết bản mới.
4. **Xong** xóa dấu đánh dấu. Bấm nút lần nữa chỉ đưa tiêu điểm vào bảng.

[Trang Focus](focus) liệt kê các dấu đánh dấu dưới **Quay lại**. Lời nhắc hiện dưới dạng thông báo push, hoặc thẻ trong trang đang mở với **Hoãn** và **Bỏ qua**. Lời nhắc đến hạn khi daemon tắt hiện ở lần khởi động sau.

## Lịch sử cục bộ (Dòng thời gian của tệp) {#local-history-file-timeline}

Đừng nhầm với dòng thời gian của phiên ở trên: mục **Dòng thời gian** dưới cây tệp của [Tệp](files) thuộc về tệp đang mở trong trình soạn thảo. Nó liệt kê, mới nhất trước, các bản **Lịch sử cục bộ** và các commit **Lịch sử Git** của tệp. Menu lọc (**Lọc dòng thời gian**) hiển thị một loại hoặc cả hai, lưu trong trình duyệt này.

- **Lịch sử cục bộ** giữ nội dung trước đó của tệp mỗi khi bạn lưu, Claude sửa hoặc một thao tác git thay thế nó. Mỗi bản chứa văn bản từ trước thay đổi, nên văn bản hiện tại luôn nằm trên đĩa.
- Mỗi bản có một lý do: "Đã lưu tệp", "Claude sửa", "Trước khi hoàn tác", "Trước khi checkout", "Trước khi reset", "Trước khi xóa stash", "Trước khi hủy", "Trước khi khôi phục", "Trước khi dán" hoặc "Bản có tên". Reset hard, Smart checkout, drop stash, Hủy và [Rollback](git#roll-back-changes) lưu văn bản bị thay thế trước, nên không cái nào làm mất công việc.
- **Tạo bản có tên** giữ tệp như hiện có trên đĩa, dưới một tên bạn đặt.
- Menu của một hàng có **So sánh với hiện tại**, **So sánh với bản trước**, và với hàng Lịch sử cục bộ có **Khôi phục**, **Đổi tên** và **Xóa**. **Khôi phục** trước tiên yêu cầu bạn lưu hoặc bỏ các thay đổi.
- Giữ tối đa 50 bản và 256 KB mỗi tệp, trong thư mục cấu hình của daemon. **Cài đặt › Lịch sử cục bộ** tắt nó và liệt kê **Đường dẫn bị loại trừ** (mẫu glob, ví dụ `**/dist/**`). Xem [Cài đặt](../reference/settings#local-history).

## Cần biết {#good-to-know}

- **Chỉ tín hiệu** áp dụng cho mọi phiên trong trình duyệt này. Prompt của bạn, văn bản của Claude, lỗi và các yêu cầu đang chờ bạn luôn hiển thị.
- Tua lại mã chỉ bao gồm các thay đổi do công cụ Edit và Write của Claude thực hiện. Nó không hoàn tác lệnh shell.
- Phiên dài tải các lượt mới nhất trước. Cuộn lên để xem các lượt cũ hơn.
- Nút sao chép cần HTTPS hoặc `localhost`.
