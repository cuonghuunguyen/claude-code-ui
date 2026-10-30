# Điều phối (worker)

Một phiên (**coordinator**) có thể khởi động và điều khiển các phiên khác (các **worker**). Mặc định tắt.

## Cách dùng {#how-to-use}

1. Mở **Cài đặt › Điều phối** và bật **Bật điều phối**.
2. Bắt đầu một phiên mới (hoặc gửi prompt tiếp theo trong phiên đang có; cài đặt áp dụng ở lần khởi động tiếp theo của phiên).
3. Yêu cầu nó dùng worker, ví dụ: "Chia việc này thành hai tác vụ và khởi động một worker cho mỗi tác vụ trong worktree riêng."
4. Worker hiện trong thanh bên dưới coordinator của chúng, như các phiên bình thường mà bạn có thể mở. Worker của một worker hiện dưới cùng coordinator, đặt tên `parent › child`.
5. Câu hỏi và yêu cầu quyền mà worker chuyển cho bạn hiện như mọi yêu cầu khác, và trên [trang Focus](/vi/features/focus).

## Cài đặt {#settings}

| Cài đặt | Tác dụng |
| --- | --- |
| **Bật điều phối** | Mọi phiên, kể cả worker, có các công cụ worker. |
| **Số worker tối đa mỗi cây** | Số worker mà một coordinator do bạn khởi động được chạy cùng lúc, tính cả worker của worker (1 đến 20, mặc định 4). Mỗi coordinator có số đếm riêng. |
| **Tổng số worker tối đa** | Số worker được chạy cùng lúc trên daemon này, qua mọi coordinator (0 đến 100; 0, mặc định, = không giới hạn). |
| **Độ sâu cây tối đa** | Worker được khởi động worker riêng sâu đến đâu (1 đến 5). 1: chỉ bạn khởi động worker. 2 (mặc định): một worker được khởi động worker riêng, ví dụ một tester và một reviewer. |
| **Số worker tối đa mỗi coordinator** | Số worker mà một phiên (bạn hoặc một worker) được chạy cùng lúc (1 đến 20, mặc định 4). |
| **Chế độ worker** | [Chế độ quyền](/vi/features/permissions) của worker mới khi coordinator không chọn. Mặc định: chế độ của chính coordinator (bypass thành auto). |
| **Thông báo từ worker** | Tắt thì worker hoàn tất, cần phản hồi hoặc lỗi sẽ không gửi thông báo push, desktop hay trong ứng dụng. Coordinator của nó vẫn nhận được tin. Yêu cầu mà coordinator chuyển tiếp cho bạn vẫn thông báo cho bạn. |
| **Coordinator được trả lời yêu cầu quyền** | Cho phép coordinator cho phép hoặc từ chối, một lần, các yêu cầu rủi ro thấp của worker: đọc và sửa trong thư mục của worker, đọc tài liệu agent của kho mã, git chỉ đọc. Mọi thứ khác chờ bạn. |

## Cây worker và plugin orchestration {#worker-trees-and-the-orchestration-plugin}

Một worker có thể khởi động worker riêng (tối đa đến **Độ sâu cây tối đa**). Thẻ `worker_start` của nó cho chế độ cao hơn nêu rõ chuỗi, ví dụ `started by worker implementer`. Mỗi coordinator chỉ nghe tin từ worker của chính nó.

Plugin `orchestration` của kho mã này thêm bốn loại agent mà worker có thể chạy (`worker_start` với `agent`): `orchestration:planner`, `orchestration:implementer`, `orchestration:ui-tester` và `orchestration:reviewer`, cùng skill `orchestrate-tickets` chạy một ticket qua các agent đó. Cài đặt một lần:

```
claude plugin marketplace add cuonghuunguyen/claude-code-ui
claude plugin install orchestration@claude-ui
```

Hoặc dùng hộp thoại Plugin. Reviewer cần skill `pr-review`; nghiệm thu dùng `playwright-cli`.

## Công cụ worker {#the-worker-tools}

<details>
<summary>11 công cụ mà coordinator nhận được (một máy chủ MCP bên trong daemon)</summary>

| Công cụ | Tác dụng |
| --- | --- |
| `worker_start` | Khởi động worker trong một thư mục hoặc trong worktree git mới, với prompt đầu tiên, tùy chọn theo loại agent |
| `worker_send` | Gửi tin nhắn cho worker (điều khiển lượt đang chạy) |
| `worker_wait` | Chờ sự kiện của worker: câu hỏi, quyền, bị từ chối, kết thúc lượt, lỗi |
| `worker_read` | Đọc dòng thời gian gần đây của worker (đường dẫn như `implementer/reviewer` đọc worker bên dưới bạn) |
| `worker_list` | Liệt kê worker và trạng thái của chúng (`tree` liệt kê mọi worker bên dưới bạn) |
| `worker_answer` | Trả lời câu hỏi thực tế đơn giản của worker |
| `worker_permission` | Cho phép một lần hoặc từ chối yêu cầu quyền mức thấp của worker |
| `worker_escalate` | Chuyển câu hỏi hoặc yêu cầu của worker cho bạn |
| `worker_stop` | Ngắt lượt đang chạy của worker |
| `worker_close` | Đóng tiến trình Claude của worker (phiên vẫn còn) |
| `worker_remove` | Xóa vĩnh viễn phiên của worker đã xong |

</details>

## Cần biết {#good-to-know}

- Worker là một phiên bình thường. Bạn có thể mở nó, nhập vào đó và tự trả lời các yêu cầu của nó. Câu trả lời đầu tiên được chấp nhận.
- Worker ở chế độ cho phép nhiều hơn coordinator của nó cần bạn đồng ý trên thẻ `worker_start`.
- `worker_close` từ chối worker còn đang chạy worker riêng; `worker_remove` từ chối worker còn bất kỳ worker nào bên dưới (hãy gỡ các worker đó trước).
- `worker_start` vượt giới hạn không hỏi bạn: worker nhận lỗi ngay.
- Yêu cầu mức cao luôn thuộc về bạn. Coordinator vẫn có thể dừng hoặc đóng worker.
- Worker tính vào mức dùng gói của bạn như mọi phiên.
