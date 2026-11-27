(() => {
  const canvas = document.getElementById('face-wireframe');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const portrait = new Image();
  portrait.src = '/static/dave-blueprint.png';
  let w=0,h=0,dpr=1,px=0,py=0,tx=0,ty=0,scroll=0,loaded=false;
  const resize=()=>{const r=canvas.getBoundingClientRect();dpr=Math.min(window.devicePixelRatio||1,2);w=r.width;h=r.height;canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);ctx.setTransform(dpr,0,0,dpr,0,0);};
  portrait.onload=()=>{loaded=true;};
  new ResizeObserver(resize).observe(canvas);resize();
  const frame=canvas.parentElement;
  frame.addEventListener('pointermove',e=>{const r=frame.getBoundingClientRect();tx=((e.clientX-r.left)/r.width-.5)*2;ty=((e.clientY-r.top)/r.height-.5)*2;},{passive:true});
  frame.addEventListener('pointerleave',()=>{tx=0;ty=0;},{passive:true});
  window.addEventListener('scroll',()=>scroll=window.scrollY*.00035,{passive:true});
  function draw(){requestAnimationFrame(draw);ctx.clearRect(0,0,w,h);px+=(tx-px)*.09;py+=(ty-py)*.09;if(!loaded||!w||!h)return;
    const scale=Math.min(w/portrait.width,h/portrait.height),dw=portrait.width*scale,dh=portrait.height*scale,ox=(w-dw)/2,oy=(h-dh)/2;
    const dx=px*7,dy=py*5+Math.sin(scroll)*2;
    ctx.save();ctx.translate(dx,dy);ctx.shadowColor='#159dff';ctx.shadowBlur=15;ctx.globalAlpha=.98;ctx.drawImage(portrait,ox,oy,dw,dh);ctx.restore();
    // The eye locations are measured on the generated blueprint crop (720 x 900).
    // Draw live irises over the traced pupils so the user's eyes follow the pointer.
    const eyes=[{x:202/720,y:283/900},{x:340/720,y:282/900}];
    eyes.forEach((eye,i)=>{const ex=ox+eye.x*dw+dx,ey=oy+eye.y*dh+dy;const gazeX=px*5.5,gazeY=py*3.2;ctx.save();ctx.shadowColor='#73e8ff';ctx.shadowBlur=12;ctx.fillStyle='rgba(88,225,255,.95)';ctx.beginPath();ctx.arc(ex+gazeX,ey+gazeY,2.7,0,Math.PI*2);ctx.fill();ctx.strokeStyle='rgba(87,218,255,.75)';ctx.lineWidth=.7;ctx.beginPath();ctx.arc(ex+gazeX,ey+gazeY,5.2,0,Math.PI*2);ctx.stroke();ctx.restore();});
    // Blueprint reticle and small live tracking indicator.
    ctx.save();ctx.strokeStyle='rgba(70,190,255,.34)';ctx.lineWidth=.7;ctx.beginPath();ctx.moveTo(w*.5-13,h*.5);ctx.lineTo(w*.5+13,h*.5);ctx.moveTo(w*.5,h*.5-13);ctx.lineTo(w*.5,h*.5+13);ctx.stroke();ctx.restore();
  }
  draw();
})();
