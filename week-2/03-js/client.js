// 1) HTML에서 요소 가져오기
const toggleBtn = document.querySelector("#toggleBtn");
const stateText = document.querySelector("#stateText");
const dancer = document.querySelector("#dancer");

// 2) 상태(ON/OFF) 저장
let isDancing = false;
let timerId = null;

// 3) 춤 포즈들(아주 단순)
const poses = [
  { transform: "translateY(-8px) rotate(-8deg)", face: "😆" },
  { transform: "translateY(0px) rotate(8deg)", face: "😎" },
  { transform: "translateY(-4px) rotate(0deg)", face: "🤪" },
];

let poseIndex = 0;

function startDance() {
  if (timerId) return;

  timerId = setInterval(() => {
    const pose = poses[poseIndex];
    dancer.style.transform = pose.transform;
    dancer.textContent = pose.face;

    poseIndex = (poseIndex + 1) % poses.length;
  }, 120);
}

function stopDance() {
  clearInterval(timerId);
  timerId = null;

  dancer.style.transform = "translateY(0px) rotate(0deg)";
  dancer.textContent = "🙂";
}

toggleBtn.addEventListener("click", () => {
  isDancing = !isDancing;

  if (isDancing) {
    stateText.textContent = "상태: ON";
    startDance();
  } else {
    stateText.textContent = "상태: OFF";
    stopDance();
  }
});
